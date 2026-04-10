#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Supprime les services/packages remplacés par l'architecture MVP.
# Lance depuis la racine du projet.
# ═══════════════════════════════════════════════════════════

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "🗑  Suppression de l'architecture over-engineered..."

# Services remplacés
rm -rf services/realtime        # → intégré dans backend/src/ws/
rm -rf services/intelligence    # → trop avancé pour MVP, supprimé
rm -rf services/workers         # → indexer écrit directement en PG
rm -rf services/alerts          # → intégré dans backend/src/jobs/alerts.ts

# Service indexer : remplacé par /indexer/ simplifié
rm -rf services/indexer

# Service API : remplacé par /backend/
rm -rf services/api

# Package Kafka : supprimé
rm -rf packages/kafka

# Infrastructure distribuée
rm -rf infra/k8s                # → Docker Compose suffit pour MVP
rm -rf infra/terraform          # → déploiement manuel ou simple VPS

# Database ClickHouse : tout en PostgreSQL
rm -rf database/clickhouse
rm -rf database/postgres        # migration PostgreSQL dans /database/migrations/

# Scripts Kafka
rm -f scripts/dev/init-kafka-topics.sh

# Anciens fichiers docker complexes
rm -f infra/docker/docker-compose.prod.yml
rm -f infra/docker/docker-compose.dev.yml

# Turbo monorepo : plus nécessaire avec la nouvelle structure
rm -f turbo.json

echo ""
echo "✅ Nettoyage terminé."
echo ""
echo "Structure MVP :"
echo "  /backend      ← Fastify (REST + WebSocket + alertes cron)"
echo "  /indexer      ← Python (blockchain → PostgreSQL)"
echo "  /database     ← Migrations PostgreSQL"
echo "  /apps/web     ← Next.js (inchangé)"
echo "  /scripts      ← Scripts utilitaires"
echo "  docker-compose.yml ← 3 conteneurs : postgres + backend + indexer"
