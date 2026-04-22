# Déploiement Rapide - Abstrack

## 1️⃣ Commit et Push du code

```bash
git add .
git commit -m "feat: prepare for deployment"
git push origin main
```

---

## 2️⃣ Déployer le Frontend (Next.js) sur Vercel

### Étapes:
1. Allez sur [vercel.com](https://vercel.com)
2. Cliquez sur **"New Project"**
3. Sélectionnez votre repo **abstrack** depuis GitHub
4. Vercel détecte automatiquement que c'est un monorepo Next.js
5. Dans **Root Directory**, mettez: `apps/web`
6. Cliquez sur **Deploy**

**Résultat:** Votre site sera accessible sur `https://abstrack.vercel.app`

---

## 3️⃣ Déployer le Backend (Fastify) sur Railway

### Étapes:
1. Allez sur [railway.app](https://railway.app)
2. Cliquez sur **New Project → Deploy from GitHub**
3. Sélectionnez votre repo **abstrack**
4. Railway va détecter le `railway.toml` à la racine
5. Laissez-le configurer le déploiement

### Variables d'environnement à ajouter dans Railway:

Cliquez sur le service backend → **Variables** et ajoutez:

```
JWT_SECRET=openssl rand -hex 32
ADMIN_SECRET=openssl rand -hex 32
CORS_ORIGIN=https://abstrack.vercel.app
NODE_ENV=production
LOG_LEVEL=info
ALPHA_WHALE_ETH=5
ALPHA_BURST_SALES=10
```

> **DATABASE_URL** sera auto-injecté si vous ajoutez le plugin PostgreSQL

---

## 4️⃣ Configurer PostgreSQL sur Railway

1. Dans Railway → **New** → **Database** → **PostgreSQL**
2. Railway injectera automatiquement **DATABASE_URL**
3. Exécutez les migrations:
   ```bash
   # Depuis votre terminal local:
   npm run db:migrate
   ```

---

## 5️⃣ Générer les secrets requis

Dans PowerShell:
```powershell
# JWT_SECRET
openssl rand -hex 32

# ADMIN_SECRET  
openssl rand -hex 32
```

Copier les valeurs dans le dashboard Railway.

---

## 6️⃣ Connecter Frontend ↔ Backend

Une fois que Railway vous donne l'URL du backend (ex: `https://backend-xyz.railway.app`):

1. Allez dans Vercel → abstrack → **Settings**
2. Allez dans **Environment Variables**
3. Ajoutez:
   ```
   NEXT_PUBLIC_API_URL=https://backend-xyz.railway.app
   NEXT_PUBLIC_WS_URL=wss://backend-xyz.railway.app
   NEXT_PUBLIC_CHAIN_ID=2741
   ```
4. Redéployez: **Deployments** → **Redeploy**

---

## 7️⃣ Vérifier que c'est en ligne

```bash
# Frontend
curl https://abstrack.vercel.app

# Backend health check
curl https://backend-xyz.railway.app/healthz

# API test
curl https://backend-xyz.railway.app/api/status
```

---

## Notes importantes

- **Domaine personnalisé?** Allez dans Vercel Settings → Domains
- **SSL/HTTPS?** Gratuit et automatique sur Vercel et Railway
- **Uptime monitoring?** Rail.app et Vercel l'incluent
- **Logs?** Consultables dans les dashboards respectifs

---

## Plan B: Docker sur VPS (Hetzner/DigitalOcean)

Si vous préférez self-host:

```bash
# Sur votre VPS:
docker compose --env-file .env up -d

# Les variables requises:
cat > .env << EOF
POSTGRES_PASSWORD=super_secure_password
JWT_SECRET=your_generated_secret
ADMIN_SECRET=your_generated_secret
CORS_ORIGIN=https://your-domain.com
NODE_ENV=production
ABSTRACT_RPC_WSS=wss://your-rpc
ABSTRACT_RPC_HTTP=https://your-rpc
EOF
```

---

## ⏱️ Temps estimé: 15-20 minutes

Besoin d'aide pour une étape spécifique?
