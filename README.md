# IGHS — Smart Vehicle Tracking & Firebase RBAC Dashboard

> A production-ready, static Single-Page Application featuring Firebase Authentication, Google Sign-In, Firestore-backed Role-Based Access Control (RBAC), and ESP32 Accident Monitoring with SMS alerts. Deploys to **Cloudflare Pages** with zero build step.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Firebase Project Setup](#1-firebase-project-setup)
3. [Configure Your Credentials](#2-configure-your-credentials)
4. [Deploy Firestore Security Rules](#3-deploy-firestore-security-rules)
5. [Promoting the First Admin User](#4-promoting-the-first-admin-user)
6. [Deploy to Cloudflare Pages](#5-deploy-to-cloudflare-pages)
7. [Authorize Your Domain in Firebase](#6-authorize-your-domain-in-firebase)
8. [File Structure](#file-structure)
9. [Security Model](#security-model)
10. [Adding Backend Actions (Cloud Functions)](#adding-backend-actions-cloud-functions)
11. [Firebase Config Values Are Safe to Expose](#firebase-config-values-are-safe-to-expose)

---

## Architecture Overview

```
GitHub Repo (static files)
    │
    ▼
Cloudflare Pages (CDN, HTTPS, edge)
    │
    ▼
index.html + styles.css + app.js + firebase-config.js
    │
    ├── Firebase Auth (Email/Password)
    │       Sign-up / Sign-in / Sign-out / onAuthStateChanged
    │
    └── Cloud Firestore
            users/{uid}  →  { email, role, createdAt }
            logs/        →  admin-only
            system/      →  admin-only
```

**No server. No build step. No npm.** Firebase is imported via ESM CDN URLs directly in the browser.

---

## 1. Firebase Project Setup

### Step 1 — Create a Firebase Project

1. Go to [https://console.firebase.google.com/](https://console.firebase.google.com/)
2. Click **"Add project"**
3. Name your project (e.g., `twlight-dashboard`)
4. Disable Google Analytics if not needed → **Create project**

### Step 2 — Enable Email/Password Authentication

1. In the left sidebar: **Build → Authentication**
2. Click **"Get started"**
3. Under **Sign-in providers**, click **Email/Password**
4. Toggle **Enable** → **Save**

### Step 3 — Create a Firestore Database

1. In the left sidebar: **Build → Firestore Database**
2. Click **"Create database"**
3. Choose **Start in production mode** (our rules will control access)
4. Select a Cloud Firestore location closest to your users
5. Click **Enable**

### Step 4 — Register a Web App

1. In **Project Overview**, click the **`</>`** (Web) icon
2. Enter an app nickname (e.g., `TwLight Web`)
3. **Do NOT** check "Firebase Hosting" (we use Cloudflare Pages)
4. Click **Register app**
5. You will see your `firebaseConfig` object — copy it for the next step

---

## 2. Configure Your Credentials

Open [`firebase-config.js`](./firebase-config.js) and replace the placeholder values:

```js
const firebaseConfig = {
  apiKey:            "AIzaSy...",                     // ← from Firebase Console
  authDomain:        "your-project.firebaseapp.com",  // ← from Firebase Console
  projectId:         "your-project-id",               // ← from Firebase Console
  storageBucket:     "your-project.appspot.com",      // ← from Firebase Console
  messagingSenderId: "123456789012",                   // ← from Firebase Console
  appId:             "1:123456789012:web:abc123..."    // ← from Firebase Console
};
```

**Where to find these values:**  
Firebase Console → ⚙️ Project Settings → **Your apps** → scroll to the web app → `firebaseConfig`

> ⚠️ These values are intentionally public-safe — see [Firebase Config Values Are Safe to Expose](#firebase-config-values-are-safe-to-expose) below.

---

## 3. Deploy Firestore Security Rules

The [`firestore.rules`](./firestore.rules) file contains the server-side security enforcement. **You must deploy these rules before your app goes live.**

### Option A — Firebase Console (no CLI needed)

1. Firebase Console → **Firestore Database → Rules** tab
2. Replace the existing rules with the full content of `firestore.rules`
3. Click **Publish**

### Option B — Firebase CLI

```bash
# Install Firebase CLI (one-time)
npm install -g firebase-tools

# Login
firebase login

# Initialize (in your project directory)
firebase init firestore
# → Select your Firebase project
# → Use existing firestore.rules file when prompted

# Deploy only the rules
firebase deploy --only firestore:rules
```

---

## 4. Promoting the First Admin User

> **⚠️ CRITICAL — READ THIS CAREFULLY**

**The client application can NEVER self-promote a user to admin.** This is enforced at the server level by Firestore Security Rules. Any `setDoc` or `updateDoc` call that attempts to set `role: "admin"` from the browser will be **rejected** by Firestore, regardless of what the client-side code does.

Admin promotion is a **privileged, out-of-band operation** that must be performed via:

### Method A — Firebase Console (Recommended for first admin)

1. Sign up through your app UI to create your account
2. Go to Firebase Console → **Firestore Database → Data**
3. Navigate to **`users` → `{your-uid}`**  
   *(Your UID appears in Authentication → Users)*
4. Click the **✏️ edit** icon next to the `role` field
5. Change the value from `"user"` to `"admin"`
6. Click **Update**
7. Sign out and sign back in — the dashboard will now show the Admin Panel

### Method B — Admin SDK Script (Recommended for automation)

Create a Node.js script (run in a trusted environment, never in the browser):

```js
// promote-admin.js — Run with: node promote-admin.js
const admin = require('firebase-admin');
const serviceAccount = require('./service-account-key.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const uid = 'PASTE_USER_UID_HERE'; // From Firebase Console → Authentication → Users

admin.firestore().doc(`users/${uid}`).update({ role: 'admin' })
  .then(() => { console.log(`✅ User ${uid} promoted to admin`); process.exit(0); })
  .catch(err => { console.error(err); process.exit(1); });
```

> **Get a service account key:** Firebase Console → ⚙️ Project Settings → **Service accounts** → Generate new private key

> **NEVER commit your service account key to Git.** Add it to `.gitignore`.

---

## 5. Deploy to Cloudflare Pages

### Step 1 — Push to GitHub

```bash
cd your-project-folder
git init
git add .
git commit -m "Initial commit — TwLight dashboard"
git remote add origin https://github.com/YOUR_USERNAME/twlight.git
git push -u origin main
```

### Step 2 — Connect to Cloudflare Pages

1. Go to [https://dash.cloudflare.com/](https://dash.cloudflare.com/)
2. Left sidebar: **Workers & Pages → Pages**
3. Click **"Create application" → "Connect to Git"**
4. Authorize GitHub and select your `twlight` repository
5. Configure the build settings:

| Setting | Value |
|---|---|
| **Framework preset** | `None` |
| **Build command** | *(leave empty)* |
| **Build output directory** | `/` |

6. Click **"Save and Deploy"**

Cloudflare will deploy instantly. You'll get a URL like `https://twlight.pages.dev`.

### Step 3 — Custom Domain (Optional)

In Cloudflare Pages → your project → **Custom domains** → Add your domain.

---

## 6. Authorize Your Domain in Firebase

Firebase Auth restricts which domains can initiate sign-in flows. You **must** add your Cloudflare Pages domain.

1. Firebase Console → **Authentication → Settings → Authorized domains**
2. Click **"Add domain"**
3. Add: `twlight.pages.dev` (replace with your actual Pages subdomain)
4. Add any custom domains too (e.g., `app.yourdomain.com`)
5. Click **Add**

> Without this step, Firebase Auth will throw an `auth/unauthorized-domain` error.

---

## File Structure

```
twlight/
├── index.html          # SPA shell — loading screen, auth, dashboard
├── styles.css          # All styles — design tokens, glassmorphism, responsive
├── app.js              # Auth logic, Firestore RBAC, DOM rendering, toasts
├── firebase-config.js  # Firebase init — replace credentials here
├── firestore.rules     # Server-side security rules — deploy to Firestore
└── README.md           # This file
```

---

## Security Model

```
┌─────────────────────────────────────────────────────────┐
│                   SECURITY LAYERS                       │
├─────────────────────────────────────────────────────────┤
│  Layer 1 (UX):   Client JS hides admin UI for non-admin │
│                  → Bypassed by a skilled user: FINE     │
│                  → No sensitive data exposed this way   │
├─────────────────────────────────────────────────────────┤
│  Layer 2 (REAL): Firestore Security Rules               │
│                  → Server-enforced, cannot be bypassed  │
│                  → role field immutable from client     │
│                  → admin-only collections truly gated   │
│                  → default-deny on all other paths      │
├─────────────────────────────────────────────────────────┤
│  Layer 3 (ADMIN):Firebase Admin SDK (server-side only)  │
│                  → Only way to promote users to admin   │
│                  → Runs in trusted Cloud Functions /    │
│                    servers, never in the browser        │
└─────────────────────────────────────────────────────────┘
```

### Key Security Guarantees

| Guarantee | How it's enforced |
|---|---|
| Users can't read each other's data | Firestore rule: `isOwner(uid)` on read |
| Users can't self-promote to admin | Firestore rule: `role == "user"` on create |
| Users can't change their own role | Firestore rule: `role` excluded from update diff |
| Admin panel never rendered for non-admin | JS: DOM injection only runs for `role === "admin"` |
| Admin collections inaccessible | Firestore rule: `isAdmin()` check on `logs/`, `system/` |
| Unknown paths rejected | Default-deny: `/{document=**} → allow: if false` |

---

## Adding Backend Actions (Cloud Functions)

The "Trigger System Backup" and "Clear Logs" buttons in the Admin Panel are **stubs** — they show a toast but do nothing on a static site. To make them real:

1. Create a [Firebase Cloud Function](https://firebase.google.com/docs/functions):

```js
// functions/index.js
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

exports.triggerBackup = onCall(async (request) => {
  // Verify the caller is an admin
  const uid  = request.auth?.uid;
  const snap = await admin.firestore().doc(`users/${uid}`).get();
  if (!snap.exists || snap.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Admin only.");
  }
  // ... your backup logic here
  return { success: true, message: "Backup started." };
});
```

2. In `app.js`, replace the stub handler with a `httpsCallable` call:

```js
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";

const functions     = getFunctions(app);
const triggerBackup = httpsCallable(functions, "triggerBackup");

backupBtn.addEventListener("click", async () => {
  const result = await triggerBackup();
  showToast(result.data.message, "success");
});
```

---

## Firebase Config Values Are Safe to Expose

A common concern is committing the Firebase `apiKey` and related values to a public GitHub repository.

**These values are designed to be public.** Here's why:

- The `apiKey` identifies your Firebase project to Google's servers — it is **not** a secret API key like those used in traditional backend services.
- It does not grant access to your database or any privileged operations.
- Real security is provided by **Firestore Security Rules** (which run on Google's servers and cannot be bypassed by clients) and **Firebase Authentication** (which verifies identity).
- Google's own documentation states: *"It is okay to include this value in your version-controlled code."*

**Reference:** [https://firebase.google.com/docs/projects/api-keys](https://firebase.google.com/docs/projects/api-keys)

The only value you should **never** expose is a **Service Account private key** (`.json` file from Project Settings → Service accounts) — that is a server-side credential with admin privileges.

---

*Built with ❤️ using vanilla HTML5, CSS3, and ES6 — no bundler, no framework, no npm.*
