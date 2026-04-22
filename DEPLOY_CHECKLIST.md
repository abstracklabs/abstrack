# 🚀 Configuration Déploiement - À faire maintenant

## 🔐 Vos Secrets (À garder privés!)

```
JWT_SECRET=CCDEA03F7A1FA0C614FDDE2F227C32584A0A731D50134098350058816548E1D0
ADMIN_SECRET=4C8895507749F86034A57D4CC8A0137B4EC0903D8F264BA8E53E90D7C3146BEC
```

**⚠️ Gardez ça secret! Ne le commitez JAMAIS.**

---

## ✅ Frontend - Vercel (5 minutes)

### Étape 1: Créer le projet
1. Allez sur https://vercel.com
2. Cliquez **"Add New" → "Project"**
3. Importez votre repo GitHub `abstrack`
4. Framework: **Next.js** (auto-détecté)
5. Root Directory: **`apps/web`**

### Étape 2: Variables d'environnement
1. Dans le project → **Settings → Environment Variables**
2. Ajoutez:
   ```
   NEXT_PUBLIC_API_URL = https://backend-XXXXX.railway.app
   NEXT_PUBLIC_WS_URL = wss://backend-XXXXX.railway.app  
   NEXT_PUBLIC_CHAIN_ID = 2741
   ```
   (Vous trouverez l'URL Railroad à l'étape suivante)

### Étape 3: Deploy
- Cliquez **"Deploy"**
- Attendez ~3 min
- Votre site est à: `https://abstrack.vercel.app` ✅

---

## ✅ Backend - Railway (10 minutes)

### Étape 1: Créer le projet
1. Allez sur https://railway.app
2. Cliquez **"New Project" → "Deploy from GitHub"**
3. Sélectionnez `abstrack`
4. Railway va utiliser `railway.toml` automatiquement

### Étape 2: Ajouter PostgreSQL
1. Dans Railway → **New** → **Database** → **PostgreSQL**
2. Railway injecte **DATABASE_URL** automatiquement

### Étape 3: Variables d'environnement Backend
1. Cliquez sur le service `backend` (ou `backend-railway`)
2. Allez dans **Variables**
3. Cliquez **"Add Variables"** et remplissez:

```
JWT_SECRET=CCDEA03F7A1FA0C614FDDE2F227C32584A0A731D50134098350058816548E1D0
ADMIN_SECRET=4C8895507749F86034A57D4CC8A0137B4EC0903D8F264BA8E53E90D7C3146BEC
CORS_ORIGIN=https://abstrack.vercel.app
NODE_ENV=production
LOG_LEVEL=info
ALPHA_WHALE_ETH=5
ALPHA_BURST_SALES=10
```

### Étape 4: Déployer
- Railway va déployer automatiquement depuis GitHub
- Attendez ~2-3 min pour le déploiement
- Votre URL backend s'affichera en haut du dashboard (ex: `https://backend-xyz123.railway.app`)

### Étape 5: Test health
```bash
# URL de Railway (visible dans le dashboard)
curl https://backend-xyz123.railway.app/healthz
```
Vous devriez avoir une réponse 200 ✅

---

## 🔗 Connexion Finale

### Copier l'URL de Railway dans Vercel

1. Dans Railway → Cliquez sur votre service Backend
2. Copiez l'URL (ex: `https://backend-abc123.railway.app`)
3. Allez dans Vercel → abstrack → **Settings → Environment Variables**
4. Mettez à jour avec cette URL:
   ```
   NEXT_PUBLIC_API_URL=https://backend-abc123.railway.app
   NEXT_PUBLIC_WS_URL=wss://backend-abc123.railway.app
   ```
5. Cliquez **"Redeploy"** (pour appliquer les nouvelles variables)

---

## ✅ Vérification Finale

```bash
# Frontend
curl https://abstrack.vercel.app

# Backend sain?
curl https://backend-xyz.railway.app/healthz

# API répondre?
curl https://backend-xyz.railway.app/api/collections
```

---

## 📋 Checklist

- [ ] Code poussé sur GitHub
- [ ] Vercel project créé
- [ ] Railway backend créé
- [ ] PostgreSQL attaché à Railway
- [ ] Variables d'env dans Railway
- [ ] Variables d'env dans Vercel
- [ ] Vercel redéployé
- [ ] Test des URLs

---

## 🆘 Problèmes courants

**"Backend ne répond pas?"**
- Vérifiez les variables d'env dans Railway
- Consultez les logs: Railway → Backend → Logs

**"CORS error?"**
- Railway: Assurez-vous `CORS_ORIGIN=https://abstrack.vercel.app` est exacte

**"Vercel build fail?"**
- Vérifiez le build dans Vercel → Deployments → Recent
- Root Directory doit être `apps/web`

---

## ⏱ Time estimate: 15-20 min total

Vous pouvez faire ça! 🚀
