// =============================================================================
// firebase-config.js — Firebase Initialization
//
// YOUR REAL CREDENTIALS ARE SET BELOW.
// These config values are intentionally public-safe — real security
// comes from Firestore Security Rules, not secrecy of these values.
// See: https://firebase.google.com/docs/projects/api-keys
//
// Firebase project: ighs-9a0f1
// Console: https://console.firebase.google.com/project/ighs-9a0f1
// =============================================================================

import { initializeApp }    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth }          from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore }     from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ---------------------------------------------------------------------------
// ✅ YOUR FIREBASE PROJECT CREDENTIALS (ighs-9a0f1)
// ---------------------------------------------------------------------------
const firebaseConfig = {
  apiKey:            "AIzaSyBdf5770e_1JVaotE6pHAuoZlPVCzdsI8c",
  authDomain:        "ighs-9a0f1.firebaseapp.com",
  projectId:         "ighs-9a0f1",
  storageBucket:     "ighs-9a0f1.firebasestorage.app",
  messagingSenderId: "714269115464",
  appId:             "1:714269115464:web:9fb386256f2c7b3c7e047d",
  measurementId:     "G-RZ4K52X44N"
};
// ---------------------------------------------------------------------------

// Initialize Firebase app (singleton — safe to call multiple times)
const app = initializeApp(firebaseConfig);

// ── Auth service ────────────────────────────────────────────────────────────
// Used for: sign-in, sign-up, sign-out, onAuthStateChanged
export const auth = getAuth(app);

// ── Firestore service ───────────────────────────────────────────────────────
// Used for: user profiles (users/{uid}), vehicle tracking, logs
// Collections created automatically on first write — no manual setup needed.
export const db = getFirestore(app);

// ── Default export ──────────────────────────────────────────────────────────
export default app;

// =============================================================================
// AUTO-CREATED FIRESTORE COLLECTIONS (no setup needed — Firestore creates
// collections automatically the first time a document is written to them):
//
//  users/{uid}
//    ├── email       : string
//    ├── role        : "user" | "admin"
//    └── createdAt   : timestamp
//
//  vehicles/{vehicleId}           ← ESP32 writes here via REST API
//    ├── lat         : number      (GPS latitude)
//    ├── lng         : number      (GPS longitude)
//    ├── speed       : number      (km/h from GPS NMEA data)
//    ├── status      : "moving" | "stopped" | "accident"
//    ├── driverId    : string      (uid of assigned driver)
//    ├── vehicleName : string      (e.g. "Truck-01")
//    └── lastUpdate  : timestamp
//
//  accidents/{accidentId}         ← Created when ESP32 detects impact
//    ├── vehicleId   : string
//    ├── lat         : number
//    ├── lng         : number
//    ├── severity    : "low" | "medium" | "high"
//    ├── smsSent     : boolean
//    ├── smsTo       : string      (e.g. "+8801XXXXXXXXX")
//    └── timestamp   : timestamp
//
//  logs/{logId}                   ← Admin-only system logs
//    ├── action      : string
//    ├── userId      : string
//    └── timestamp   : timestamp
//
// =============================================================================
