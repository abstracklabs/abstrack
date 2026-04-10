# Abstrack — Deployment Guide

## Architecture cible

```
                           ┌─────────────────────────────────────────────┐
                           │              abstrack.xyz                   │
                           │                                             │
Internet ──► Vercel CDN ──►│  Next.js  (SSR + Edge)                     │
                           │  Cache:   Vercel KV + ISR                  │
                           └──────────────┬──────────────────────────────┘
                                          │ API calls / WS
                           ┌──────────────▼──────────────────────────────┐
                           │         AWS ECS Fargate (eu-west-1)         │
                           │                                             │
                           │  ALB ──► /api/*   → api       (×2)         │
                           │       ──► /ws      → realtime  (×2)         │
                           │                                             │
                           │  ECS ──► indexer      (×1, Recreate)        │
                           │       ──► intelligence (×1)                 │
                           │       ──► alerts      (×1, Recreate)        │
                           │       ──► nft-worker  (×2)                  │
                           └──────────────┬──────────────────────────────┘
                                          │ managed services
                           ┌──────────────▼──────────────────────────────┐
                           │  Upstash Kafka  │  Upstash Redis            │
                           │  Supabase PG    │  ClickHouse Cloud         │
                           └─────────────────────────────────────────────┘
```

---

## 1. Services managés (à provisionner en premier)

### Kafka — Upstash
- Créer un cluster dans la région `eu-west-1`
- Créer les topics manuellement :

```bash
# Via Upstash Console ou upstash-cli
topics=(
  "abstrack.nft.sales"
  "abstrack.nft.transfers"
  "abstrack.tokens.swaps"
  "abstrack.intelligence.whale_detected"
  "abstrack.intelligence.smart_money"
  "abstrack.reorgs"
)

for topic in "${topics[@]}"; do
  upstash kafka topic create "$topic" \
    --partitions 2 \
    --retention-ms 604800000    # 7 jours
done
```

### Redis — Upstash
- Créer une instance `eu-west-1`, tier Pro (persistence activée)
- Activer **Eviction policy**: `allkeys-lru`
- Taille recommandée : 1 Go pour commencer

### PostgreSQL — Supabase
- Créer un projet `abstrack-prod` en `eu-west-1`
- Exécuter les migrations :

```bash
psql $DATABASE_URL < database/postgres/migrations/001_initial.sql
psql $DATABASE_URL < database/postgres/migrations/002_alerts_v2.sql
```

### ClickHouse — ClickHouse Cloud
- Créer un service en `eu-west-1`, tier Development (8 Go RAM)
- Exécuter les migrations :

```bash
clickhouse-client --host HOST --user default --password PWD \
  --multiquery < database/clickhouse/tables/nft_sales.sql

clickhouse-client --host HOST --user default --password PWD \
  --multiquery < database/clickhouse/tables/wallet_activity.sql

clickhouse-client --host HOST --user default --password PWD \
  --multiquery < database/clickhouse/tables/intelligence.sql

clickhouse-client --host HOST --user default --password PWD \
  --multiquery < database/clickhouse/tables/wallet_intelligence.sql
```

---

## 2. Variables d'environnement

Stocker dans **AWS SSM Parameter Store** (SecureString) :

```bash
PARAMS=(
  "ABSTRACT_RPC_WSS"
  "KAFKA_BROKERS" "KAFKA_USERNAME" "KAFKA_PASSWORD"
  "REDIS_URL"
  "DATABASE_URL"
  "CLICKHOUSE_URL" "CLICKHOUSE_USER" "CLICKHOUSE_PASSWORD"
  "API_JWT_SECRET"
  "RESEND_API_KEY"
)

for param in "${PARAMS[@]}"; do
  aws ssm put-parameter \
    --name "/abstrack-prod/$param" \
    --value "VALEUR_ICI" \
    --type SecureString \
    --overwrite
done
```

Secrets GitHub Actions nécessaires :
```
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
VERCEL_TOKEN
VERCEL_ORG_ID
VERCEL_PROJECT_ID
SLACK_WEBHOOK_URL         (optionnel)
TURBO_TOKEN               (optionnel, cache Turborepo)
```

---

## 3. Déploiement AWS (Terraform)

```bash
cd infra/terraform

# Init backend S3 (créer le bucket d'abord)
aws s3 mb s3://abstrack-tfstate --region eu-west-1

terraform init
terraform plan -var-file=prod.tfvars
terraform apply -var-file=prod.tfvars
```

Résultats obtenus :
- ALB DNS → pointer `api.abstrack.xyz` (CNAME)
- ECR URLs → configurées dans le workflow CI/CD

---

## 4. Premier déploiement manuel

```bash
# Build + push de toutes les images
SERVICES=(api realtime indexer intelligence alerts)
ECR="123456789.dkr.ecr.eu-west-1.amazonaws.com"
SHA=$(git rev-parse --short HEAD)

aws ecr get-login-password --region eu-west-1 | \
  docker login --username AWS --password-stdin $ECR

for svc in "${SERVICES[@]}"; do
  docker build -t $ECR/abstrack-$svc:$SHA services/$svc/
  docker push $ECR/abstrack-$svc:$SHA
done

# Frontend
docker build -t $ECR/abstrack-web:$SHA \
  --build-arg NEXT_PUBLIC_API_URL=https://api.abstrack.xyz \
  --build-arg NEXT_PUBLIC_WS_URL=wss://ws.abstrack.xyz \
  apps/web/
docker push $ECR/abstrack-web:$SHA

# Puis les pushs suivants sont automatiques via GitHub Actions
```

---

## 5. Scaling — règles par service

| Service       | Min | Max | Trigger                        | Notes                              |
|---------------|-----|-----|--------------------------------|------------------------------------|
| `api`         | 2   | 10  | CPU > 70%                      | Stateless, scale librement         |
| `realtime`    | 2   | 8   | CPU > 60% / mémoire > 75%      | Sticky sessions ALB requises       |
| `indexer`     | **1** | **1** | —                           | Jamais > 1 (checkpoint Redis)      |
| `intelligence`| 1   | 1   | —                              | Consumer group isolé               |
| `alerts`      | **1** | **1** | —                           | Déduplication Redis → Recreate     |
| `nft-worker`  | 2   | 6   | CPU > 70%                      | = nb partitions Kafka              |

> **Règle critique** : `indexer` et `alerts` utilisent `strategy: Recreate`
> (K8s) ou `Desired count = 1` sans autoscaling (ECS).
> Deux instances de ces services produiraient des doublons ou des alertes dupliquées.

---

## 6. Monitoring

### Métriques Prometheus (indexer :9090)
Scraped automatiquement si annotations K8s `prometheus.io/scrape: "true"`.

Alertes à configurer :
```yaml
# Exemple Prometheus alerting rules
groups:
  - name: abstrack
    rules:
      - alert: IndexerLagHigh
        expr: abstrack_indexer_block_lag > 50
        for: 2m
        labels:    { severity: critical }
        annotations:
          summary: "Indexer is {{ $value }} blocks behind"

      - alert: APIHighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
        for: 1m
        labels:    { severity: warning }
        annotations:
          summary: "API error rate {{ $value | humanizePercentage }}"
```

### CloudWatch (ECS)
Les logs de tous les services sont dans `/ecs/abstrack-prod/{service}`.

Dashboard recommandé :
- `api` : req/s, latency p99, error rate
- `realtime` : connexions WS actives, messages/s
- `indexer` : blocks/s, lag vs tip, reorgs détectés

---

## 7. Checklist déploiement production

- [ ] Services managés provisionnés (Kafka topics, Redis, PG migrations, CH migrations)
- [ ] Secrets dans SSM Parameter Store
- [ ] Certificat ACM validé pour `*.abstrack.xyz`
- [ ] Terraform appliqué (VPC, ALB, ECS, ECR)
- [ ] DNS configuré (`api.abstrack.xyz` → ALB, `ws.abstrack.xyz` → ALB)
- [ ] Premier build + push images ECR
- [ ] ECS services `desired count` mis à 1+
- [ ] Indexer sanity check : `GET /healthz` retourne `{ lag: N }` avec N < 10
- [ ] Vercel project connecté au repo (deploy automatique sur merge main)
- [ ] NEXT_PUBLIC_API_URL et NEXT_PUBLIC_WS_URL configurés dans Vercel
- [ ] Alertes Prometheus configurées
- [ ] Test bout-en-bout : NFT sale indexé → visible dans UI en < 3s
