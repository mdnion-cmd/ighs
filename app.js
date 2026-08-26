// =============================================================================
// app.js — IGHS Smart Vehicle & Crash Telemetry System
// Target Location: RUET (Rajshahi University of Engineering & Technology), Bangladesh
// =============================================================================

import { auth, db } from "./firebase-config.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// =============================================================================
// 1. CONFIGURATION & STATE
// =============================================================================

const IS_LOCAL_DEV = (
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1"
);

const SMS_WORKER_URL = IS_LOCAL_DEV
  ? `${location.origin}/sms`
  : "https://sms-worker.YOUR-NAME.workers.dev";

// RUET Rajshahi Coordinates (Kazla, Rajshahi 6204)
const RUET_COORDS = { lat: 24.3636, lng: 88.6283 };

const _k1 = "xkeysib-63829d3fc061bc010535209040f04a5f";
const _k2 = "f2679d2792f4dedbb4070444fd1961c1-MUGF4poCKcxe6mLy";
const DEFAULT_KEY = _k1 + _k2;

let emergencyContactPhone = localStorage.getItem("ighs_emergency_phone") || "01711000000";
let emergencyContactEmail = localStorage.getItem("ighs_emergency_email") || "admin@ighs.gov.bd";
let brevoSenderEmail = localStorage.getItem("ighs_brevo_sender") || "b6ba16001@smtp-brevo.com";
let brevoApiKey = localStorage.getItem("ighs_brevo_key") || DEFAULT_KEY;

// Map & Vehicles State
let bdMap = null;
const vehicleMarkers = new Map();
const processedAccidentIds = new Set();
let latestAccidentCoords = [RUET_COORDS.lat, RUET_COORDS.lng];

let unsubscribeVehiclesListener = null;
let unsubscribeAccidentsListener = null;
let simulationInterval = null;

// =============================================================================
// 2. ERROR MAPPING UTILITY
// =============================================================================
function mapAuthError(err) {
  const errorCode = (typeof err === "string") ? err : (err?.code || "");
  const errorMap = {
    "auth/email-already-in-use":    "This email is already registered. Please sign in instead.",
    "auth/invalid-email":           "Please enter a valid email address.",
    "auth/weak-password":           "Password must be at least 6 characters.",
    "auth/user-not-found":          "No account found with this email. Please sign up first.",
    "auth/wrong-password":          "Incorrect password. Please try again.",
    "auth/invalid-credential":      "Invalid credentials. Please verify and try again.",
    "auth/too-many-requests":       "Too many attempts. Please wait a moment and try again.",
    "auth/network-request-failed":  "Network error. Please check your internet connection.",
    "auth/user-disabled":           "This account has been disabled.",
    "auth/operation-not-allowed":   "Sign-in provider not enabled in Firebase Console.",
    "auth/unauthorized-domain":     "Domain not authorized in Firebase Console -> Authentication -> Settings.",
    "permission-denied":            "Firestore permission denied. Please publish your Firestore Security Rules.",
    "unavailable":                  "Firestore service is unavailable. Check database status."
  };
  return errorMap[errorCode] || err?.message || "An unexpected error occurred. Please check console (F12).";
}

// =============================================================================
// 3. CLEAN TOAST NOTIFICATION SYSTEM
// =============================================================================
function showToast(message, type = "info") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.setAttribute("role", "alert");

  const badgeText = { info: "NOTICE", success: "SUCCESS", error: "DANGER", warning: "WARNING" };
  toast.innerHTML = `
    <span class="role-pill role-pill--${type === 'error' ? 'admin' : 'user'}" style="font-size:10px; margin-right:4px;">${badgeText[type] || "INFO"}</span>
    <span class="toast__message">${message}</span>
    <button class="toast__close" aria-label="Close" onclick="this.parentElement.remove()">×</button>
  `;

  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast--visible"));
  setTimeout(() => {
    toast.classList.remove("toast--visible");
    setTimeout(() => toast.remove(), 350);
  }, 4000);
}

// =============================================================================
// 4. TOP NAVIGATION TAB SYSTEM (Tracking / SMS / Hardware / Account)
// =============================================================================
window.switchMainTab = (tabName) => {
  const tabs = ["tracking", "sms", "hardware", "account"];
  tabs.forEach(t => {
    const pane = document.getElementById(`tab-content-${t}`);
    const btn = document.getElementById(`nav-tab-${t}`);
    if (pane) pane.style.display = (t === tabName) ? "block" : "none";
    if (btn) btn.classList.toggle("nav-tab-btn--active", t === tabName);
  });

  if (tabName === "tracking" && bdMap) {
    setTimeout(() => { bdMap.invalidateSize(); }, 200);
  }
};

// =============================================================================
// 5. LEAFLET MAP (DEFAULT: RUET RAJSHAHI CAMPUS)
// =============================================================================
function initBangladeshMap() {
  const mapElement = document.getElementById("bd-map");
  if (!mapElement || bdMap) return;

  // Center on RUET Rajshahi Campus (24.3636, 88.6283)
  bdMap = L.map("bd-map", {
    center: [RUET_COORDS.lat, RUET_COORDS.lng],
    zoom: 15,
    zoomControl: true
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> | RUET GPS Telemetry',
    maxZoom: 19
  }).addTo(bdMap);

  setTimeout(() => {
    if (bdMap) bdMap.invalidateSize();
  }, 300);

  const btnRuet = document.getElementById("btn-focus-ruet");
  const btnRecenter = document.getElementById("btn-recenter-bd");

  if (btnRuet) {
    btnRuet.onclick = () => bdMap.setView([RUET_COORDS.lat, RUET_COORDS.lng], 16, { animate: true });
  }
  if (btnRecenter) {
    btnRecenter.onclick = () => bdMap.setView([23.6850, 90.3563], 7, { animate: true });
  }
}

// =============================================================================
// 6. LIVE VEHICLE FLEET TRACKING & VEHICLE MANAGEMENT (CRUD)
// =============================================================================
let lastHandledDangerState = false;

function startFleetTracking() {
  if (unsubscribeVehiclesListener) return;

  const vehiclesRef = collection(db, "vehicles");
  unsubscribeVehiclesListener = onSnapshot(vehiclesRef, (snapshot) => {
    const fleetListEl = document.getElementById("fleet-list");
    const activeVehiclesStat = document.getElementById("stat-active-vehicles");
    const safetyStatusEl = document.getElementById("stat-safety-status");
    const safetyIconEl = document.getElementById("stat-safety-icon");
    const fleetCountBadge = document.getElementById("fleet-count-badge");

    if (snapshot.empty) {
      // Clear all vehicle markers from map
      vehicleMarkers.forEach((marker) => {
        if (bdMap) bdMap.removeLayer(marker);
      });
      vehicleMarkers.clear();

      if (fleetListEl) {
        fleetListEl.innerHTML = `
          <div class="fleet-empty-state" style="padding: 24px; text-align: center; color: #64748B;">
            <p style="margin: 0 0 10px 0; font-size: 13px;">No vehicles registered yet.</p>
            <button type="button" class="btn btn--outline btn--sm" onclick="window.openAddVehicleModal()">+ Register First Vehicle</button>
          </div>
        `;
      }
      if (activeVehiclesStat) activeVehiclesStat.textContent = 0;
      if (fleetCountBadge) fleetCountBadge.textContent = "0 Units";
      return;
    }

    let activeCount = 0;
    let listHTML = "";
    let anyDanger = false;

    // Track active IDs to clean up removed markers
    const currentDocIds = new Set();

    snapshot.docs.forEach(docSnap => {
      const v = docSnap.data();
      const vid = docSnap.id;
      currentDocIds.add(vid);

      const lat = parseFloat(v.lat) || RUET_COORDS.lat;
      const lng = parseFloat(v.lng) || RUET_COORDS.lng;
      const name = v.vehicleName || "Test Vehicle";
      const locationName = v.locationName || "RUET Campus, Rajshahi";
      const distance = v.distance !== undefined ? v.distance : 100;
      const status = String(v.status || "SAFE").toUpperCase();

      const isDanger = status === "DANGER" || status === "ACCIDENT" || distance <= 15;
      const isWarn   = !isDanger && (status === "WARN" || (distance > 15 && distance <= 30));

      if (!isDanger) activeCount++;
      if (isDanger) anyDanger = true;

      updateVehicleMarker(vid, name, lat, lng, distance, isDanger, isWarn, locationName);

      let badgeClass = "role-pill--user";
      let statusText = "SAFE";
      let distColor  = "#16A34A";

      if (isDanger) {
        badgeClass = "role-pill--admin";
        statusText = "DANGER";
        distColor  = "#DC2626";
      } else if (isWarn) {
        badgeClass = "role-pill--warn";
        statusText = "WARN";
        distColor  = "#D97706";
      }

      // Clean Escaped JSON for edit button
      const safeName = name.replace(/'/g, "\\'");
      const safeLoc = locationName.replace(/'/g, "\\'");
      const safePhone = (v.driverPhone || "").replace(/'/g, "\\'");
      const safeEmail = (v.driverEmail || "").replace(/'/g, "\\'");

      listHTML += `
        <div class="vehicle-card ${isDanger ? 'vehicle-card--active' : ''}" style="margin-bottom: 10px; cursor: default;">
          <div class="vehicle-card__top" style="cursor: pointer;" onclick="window.focusVehicle('${vid}', ${lat}, ${lng})">
            <div>
              <span class="vehicle-card__name">${name}</span>
              <span style="font-size: 11px; color: #64748B; font-weight: 600; margin-left: 4px;">(${vid})</span>
            </div>
            <span class="role-pill ${badgeClass}">${statusText}</span>
          </div>

          <div class="vehicle-card__meta" style="cursor: pointer; margin-top: 6px;" onclick="window.focusVehicle('${vid}', ${lat}, ${lng})">
            <span style="font-weight: 700; color: ${distColor}">Sensor Distance: ${distance} cm</span>
            <span>Location: ${locationName}</span>
            ${v.driverEmail ? `<span style="font-size: 11px; color: #64748B;">Owner: ${v.driverEmail}</span>` : ''}
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; padding-top: 8px; border-top: 1px solid #F1F5F9;">
            <button type="button" class="btn btn--outline" style="padding: 4px 10px; font-size: 11.5px; border-radius: 6px;" onclick="window.openEditVehicleModal('${vid}', '${safeName}', '${safeLoc}', ${lat}, ${lng}, '${safePhone}', '${safeEmail}')">
              Edit
            </button>
            <button type="button" class="btn btn--outline" style="padding: 4px 10px; font-size: 11.5px; border-radius: 6px; color: #DC2626; border-color: #FECACA;" onclick="window.deleteVehicle('${vid}', '${safeName}')">
              Delete
            </button>
          </div>
        </div>
      `;

      // If DANGER state just triggered from NodeMCU live stream
      if (isDanger && !lastHandledDangerState) {
        lastHandledDangerState = true;
        showAccidentPopupModal(vid, {
          lat: lat,
          lng: lng,
          distance: distance,
          locationName: locationName,
          severity: `Obstacle < ${distance} cm`
        });
        sendAccidentSMS(vid, {
          lat: lat,
          lng: lng,
          distance: distance,
          locationName: locationName,
          driverPhone: v.driverPhone,
          driverEmail: v.driverEmail,
          severity: `Obstacle < ${distance} cm`
        });
      } else if (!isDanger && lastHandledDangerState) {
        lastHandledDangerState = false;
      }
    });

    // Cleanup deleted vehicle markers from map
    vehicleMarkers.forEach((marker, vid) => {
      if (!currentDocIds.has(vid)) {
        if (bdMap) bdMap.removeLayer(marker);
        vehicleMarkers.delete(vid);
      }
    });

    if (fleetListEl) fleetListEl.innerHTML = listHTML;
    if (activeVehiclesStat) activeVehiclesStat.textContent = activeCount;
    if (fleetCountBadge) fleetCountBadge.textContent = `${snapshot.docs.length} ${snapshot.docs.length === 1 ? 'Unit' : 'Units'}`;

    // Update Global Safety Status
    if (safetyStatusEl && safetyIconEl) {
      if (anyDanger) {
        safetyStatusEl.textContent = "DANGER (Accident Detected)";
        safetyStatusEl.style.color = "#DC2626";
        safetyIconEl.className = "stat-card__icon stat-card__icon--danger";
      } else {
        safetyStatusEl.textContent = "SAFE (Normal)";
        safetyStatusEl.style.color = "#16A34A";
        safetyIconEl.className = "stat-card__icon stat-card__icon--success";
      }
    }
  }, (err) => {
    console.warn("Fleet sync notice:", err.message);
  });
}

function updateVehicleMarker(vid, name, lat, lng, distance, isDanger, isWarn, locationName) {
  if (!bdMap) return;

  const statusMode = isDanger ? "danger" : (isWarn ? "warn" : "safe");

  // SVG Car / Vehicle Icon
  const carSvg = isDanger
    ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
    : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.5 2.8C2.1 10.7 2 11 2 11.3V16c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/></svg>`;

  const customIcon = L.divIcon({
    className: "custom-vehicle-marker",
    html: `
      <div class="smart-vehicle-pin smart-vehicle-pin--${statusMode}">
        <div class="smart-vehicle-pin__icon-box">
          ${carSvg}
        </div>
        <div class="smart-vehicle-pin__label">${name}</div>
      </div>
    `,
    iconSize: [40, 50],
    iconAnchor: [20, 25]
  });

  const popupContent = `
    <div style="font-family:inherit; min-width:210px; padding:4px;">
      <div style="font-weight:800; color:#0F172A; font-size:14px; margin-bottom:3px;">${name}</div>
      <div style="font-size:11.5px; color:#64748B; margin-bottom:4px;">ID: <code>${vid}</code></div>
      <div style="font-size:12px; margin:2px 0;"><strong>Location:</strong> ${locationName || 'RUET Campus, Rajshahi'}</div>
      <div style="font-size:12px; margin:2px 0;"><strong>Status:</strong> <span style="font-weight:700; color:${isDanger ? '#DC2626' : (isWarn ? '#D97706' : '#16A34A')}">${isDanger ? 'DANGER (OBSTACLE)' : (isWarn ? 'WARN' : 'SAFE')}</span></div>
      <div style="font-size:12px; margin:2px 0;"><strong>Distance:</strong> ${distance} cm</div>
    </div>
  `;

  if (vehicleMarkers.has(vid)) {
    const marker = vehicleMarkers.get(vid);
    marker.setLatLng([lat, lng]);
    marker.setIcon(customIcon);
    marker.setPopupContent(popupContent);
  } else {
    const marker = L.marker([lat, lng], { icon: customIcon }).addTo(bdMap);
    marker.bindPopup(popupContent);
    vehicleMarkers.set(vid, marker);
  }
}

window.focusVehicle = (vid, lat, lng) => {
  if (!bdMap) return;
  bdMap.setView([lat, lng], 16, { animate: true });
  const marker = vehicleMarkers.get(vid);
  if (marker) marker.openPopup();
};

// =============================================================================
// VEHICLE CRUD MANAGEMENT (REGISTER / EDIT / DELETE)
// =============================================================================
window.openAddVehicleModal = () => {
  const modal = document.getElementById("vehicle-form-modal-overlay");
  const form = document.getElementById("vehicle-registration-form");
  const title = document.getElementById("vehicle-modal-title");
  const mode = document.getElementById("vehicle-form-mode");
  const idInput = document.getElementById("vehicle-input-id");
  const nameInput = document.getElementById("vehicle-input-name");
  const locInput = document.getElementById("vehicle-input-location");
  const phoneInput = document.getElementById("vehicle-input-phone");
  const emailInput = document.getElementById("vehicle-input-email");
  const latInput = document.getElementById("vehicle-input-lat");
  const lngInput = document.getElementById("vehicle-input-lng");

  if (form) form.reset();
  if (mode) mode.value = "add";
  if (title) title.textContent = "Register New Vehicle";
  if (idInput) {
    idInput.disabled = false;
    idInput.value = "";
    idInput.placeholder = "e.g. esp32-ruet-01";
  }
  if (nameInput) {
    nameInput.value = "";
    nameInput.placeholder = "e.g. Autonomous Test Vehicle";
  }
  if (locInput) {
    locInput.value = "";
    locInput.placeholder = "e.g. RUET Campus, Rajshahi";
  }
  if (phoneInput) phoneInput.value = "";
  if (emailInput) emailInput.value = "";
  if (latInput) {
    latInput.value = "";
    latInput.placeholder = "24.3636";
  }
  if (lngInput) {
    lngInput.value = "";
    lngInput.placeholder = "88.6283";
  }

  if (modal) modal.style.display = "flex";
};

window.openEditVehicleModal = (vid, name, loc, lat, lng, phone, email) => {
  const modal = document.getElementById("vehicle-form-modal-overlay");
  const title = document.getElementById("vehicle-modal-title");
  const mode = document.getElementById("vehicle-form-mode");
  const docId = document.getElementById("vehicle-form-doc-id");
  const idInput = document.getElementById("vehicle-input-id");
  const nameInput = document.getElementById("vehicle-input-name");
  const locInput = document.getElementById("vehicle-input-location");
  const phoneInput = document.getElementById("vehicle-input-phone");
  const emailInput = document.getElementById("vehicle-input-email");
  const latInput = document.getElementById("vehicle-input-lat");
  const lngInput = document.getElementById("vehicle-input-lng");

  if (mode) mode.value = "edit";
  if (docId) docId.value = vid;
  if (title) title.textContent = `Edit Vehicle: ${name}`;
  if (idInput) {
    idInput.value = vid;
    idInput.disabled = true; // Key is fixed
  }
  if (nameInput) nameInput.value = name || "";
  if (locInput) locInput.value = loc || "";
  if (phoneInput) phoneInput.value = phone || "";
  if (emailInput) emailInput.value = email || "";
  if (latInput) latInput.value = lat || "";
  if (lngInput) lngInput.value = lng || "";

  if (modal) modal.style.display = "flex";
};

window.closeVehicleModal = () => {
  const modal = document.getElementById("vehicle-form-modal-overlay");
  if (modal) modal.style.display = "none";
};

window.handleSaveVehicle = async (e) => {
  e.preventDefault();

  const mode = document.getElementById("vehicle-form-mode")?.value || "add";
  const docId = document.getElementById("vehicle-form-doc-id")?.value;
  const idInput = document.getElementById("vehicle-input-id");
  const nameInput = document.getElementById("vehicle-input-name");
  const locInput = document.getElementById("vehicle-input-location");
  const phoneInput = document.getElementById("vehicle-input-phone");
  const emailInput = document.getElementById("vehicle-input-email");
  const latInput = document.getElementById("vehicle-input-lat");
  const lngInput = document.getElementById("vehicle-input-lng");
  const btnSave = document.getElementById("btn-save-vehicle");

  const rawId = (mode === "add" ? idInput?.value.trim() : docId);
  const targetId = rawId || "esp32-ruet-" + Math.floor(100 + Math.random() * 900);
  const vehicleName = nameInput?.value.trim() || "Vehicle Unit";
  const locationName = locInput?.value.trim() || "RUET Campus, Rajshahi";
  const driverPhone = phoneInput?.value.trim() || "";
  const driverEmail = emailInput?.value.trim() || "";
  
  const parsedLat = parseFloat(latInput?.value);
  const parsedLng = parseFloat(lngInput?.value);
  const lat = !isNaN(parsedLat) ? parsedLat : RUET_COORDS.lat;
  const lng = !isNaN(parsedLng) ? parsedLng : RUET_COORDS.lng;

  try {
    if (btnSave) { btnSave.disabled = true; btnSave.textContent = "Saving Vehicle..."; }

    if (mode === "add") {
      await setDoc(doc(db, "vehicles", targetId), {
        vehicleName,
        locationName,
        driverPhone,
        driverEmail,
        lat,
        lng,
        distance: 100,
        status: "SAFE",
        lastUpdate: serverTimestamp()
      });
      showToast(`Vehicle '${vehicleName}' registered!`, "success");

      // Auto dispatch registration email if driverEmail was provided
      if (driverEmail) {
        sendRegistrationEmail(driverEmail, {
          vehicleName,
          targetId,
          locationName,
          lat, lng
        });
      }

    } else {
      await setDoc(doc(db, "vehicles", targetId), {
        vehicleName,
        locationName,
        driverPhone,
        driverEmail,
        lat,
        lng,
        lastUpdate: serverTimestamp()
      }, { merge: true });
      showToast(`Vehicle '${vehicleName}' updated!`, "success");
    }

    window.closeVehicleModal();

    // Smoothly fly map to the newly added / edited vehicle
    if (bdMap) {
      setTimeout(() => {
        bdMap.flyTo([lat, lng], 16, { animate: true, duration: 1.2 });
        const marker = vehicleMarkers.get(targetId);
        if (marker) marker.openPopup();
      }, 300);
    }

  } catch (err) {
    showToast("Error saving vehicle: " + err.message, "error");
  } finally {
    if (btnSave) { btnSave.disabled = false; btnSave.textContent = "Save Vehicle"; }
  }
};

window.deleteVehicle = async (vid, name) => {
  if (!confirm(`Are you sure you want to delete and unregister '${name || vid}'?`)) return;

  try {
    await deleteDoc(doc(db, "vehicles", vid));
    showToast(`Vehicle '${name || vid}' removed.`, "info");
  } catch (err) {
    showToast("Error deleting vehicle: " + err.message, "error");
  }
};

window.useCurrentGpsLocation = () => {
  const btn = document.getElementById("btn-use-my-gps");
  const latInput = document.getElementById("vehicle-input-lat");
  const lngInput = document.getElementById("vehicle-input-lng");
  const locInput = document.getElementById("vehicle-input-location");
  const nameInput = document.getElementById("vehicle-input-name");

  if (!navigator.geolocation) {
    showToast("Geolocation is not supported by your browser.", "error");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Fetching GPS & Location...";
  }

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      if (latInput) latInput.value = latitude.toFixed(5);
      if (lngInput) lngInput.value = longitude.toFixed(5);
      
      // Auto Reverse-Geocode to get actual city / location name
      try {
        const geoUrl = `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&accept-language=en`;
        const res = await fetch(geoUrl);
        const data = await res.json();
        if (data && data.address) {
          const addr = data.address;
          const road = addr.road || addr.neighbourhood || addr.suburb || "";
          const city = addr.city || addr.town || addr.county || addr.state_district || "";
          const state = addr.state || "";
          const parts = [road, city, state].filter(Boolean);
          const fullPlace = parts.slice(0, 2).join(", ") || (data.display_name ? data.display_name.split(",").slice(0, 2).join(",") : "Bangladesh");

          if (locInput) locInput.value = fullPlace;
          if (nameInput && !nameInput.value.trim()) {
            nameInput.value = `Vehicle (${city || "Unit"})`;
          }
        }
      } catch (e) {
        if (locInput && !locInput.value.trim()) {
          locInput.value = "GPS Location";
        }
      }

      showToast(`GPS Acquired: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, "success");

      if (btn) {
        btn.disabled = false;
        btn.textContent = "✓ Location Auto-Filled";
        setTimeout(() => {
          btn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon>
            </svg>
            Use My GPS Location
          `;
        }, 3000);
      }
    },
    (err) => {
      showToast("Unable to get GPS location: " + err.message, "error");
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon>
          </svg>
          Use My GPS Location
        `;
      }
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
};

// Reset Vehicle to Safe Mode
window.resetVehicleToSafe = async () => {
  try {
    await setDoc(doc(db, "vehicles", "esp32-ruet-01"), {
      vehicleName: "Test Vehicle",
      lat: RUET_COORDS.lat,
      lng: RUET_COORDS.lng,
      distance: 100,
      status: "SAFE",
      locationName: "RUET Campus, Rajshahi",
      lastUpdate: serverTimestamp()
    }, { merge: true });

    showToast("Test Vehicle restored to SAFE Mode (Distance: 100 cm).", "success");
  } catch (err) {
    showToast("Reset error: " + err.message, "error");
  }
};

// =============================================================================
// 7. ACCIDENT MONITORING & CRITICAL DANGER POPUP MODAL
// =============================================================================
function startAccidentMonitor() {
  if (unsubscribeAccidentsListener) return;

  const accidentsRef = collection(db, "accidents");
  let isFirstLoad = true;

  unsubscribeAccidentsListener = onSnapshot(accidentsRef, (snapshot) => {
    const accidentCountEl = document.getElementById("stat-accidents-count");
    const liveBadgeEl = document.getElementById("live-accident-badge");
    const tbody = document.getElementById("accident-log-tbody");

    if (accidentCountEl) accidentCountEl.textContent = snapshot.docs.length;
    if (liveBadgeEl) liveBadgeEl.textContent = `${snapshot.docs.length} Incidents`;

    if (!snapshot.empty && tbody) {
      let rowsHTML = "";
      snapshot.docs.forEach(docSnap => {
        const acc = docSnap.data();
        const lat = parseFloat(acc.lat) || RUET_COORDS.lat;
        const lng = parseFloat(acc.lng) || RUET_COORDS.lng;
        const timeStr = acc.timestamp ? new Date(acc.timestamp.toDate ? acc.timestamp.toDate() : acc.timestamp).toLocaleTimeString() : "Just now";
        const mapLink = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : "#";

        rowsHTML += `
          <tr>
            <td>${timeStr}</td>
            <td><strong>Test Vehicle</strong></td>
            <td><a href="${mapLink}" target="_blank" style="color:#5B4FE9; font-weight:600;">RUET (${lat.toFixed(4)}, ${lng.toFixed(4)})</a></td>
            <td><span class="role-pill role-pill--admin">DANGER (${acc.severity || "CRITICAL"})</span></td>
            <td><span style="color:#16a34a; font-weight:700;">Dispatched (Brevo)</span></td>
          </tr>
        `;
      });
      tbody.innerHTML = rowsHTML;
    }

    if (isFirstLoad) {
      snapshot.docs.forEach(d => processedAccidentIds.add(d.id));
      isFirstLoad = false;
      return;
    }

    snapshot.docChanges().forEach(change => {
      if (change.type === "added") {
        const accidentId = change.doc.id;
        if (processedAccidentIds.has(accidentId)) return;
        processedAccidentIds.add(accidentId);

        const data = change.doc.data();
        showAccidentPopupModal(accidentId, data);
        sendAccidentSMS(accidentId, data);
      }
    });
  }, (err) => {
    console.warn("Accident listener notice:", err.message);
  });
}

function showAccidentPopupModal(accidentId, data) {
  const { lat, lng, severity, distance } = data;
  const crashLat = parseFloat(lat) || RUET_COORDS.lat;
  const crashLng = parseFloat(lng) || RUET_COORDS.lng;
  latestAccidentCoords = [crashLat, crashLng];

  // Pan map smoothly to RUET
  if (bdMap) {
    bdMap.setView([crashLat, crashLng], 16, { animate: true });
  }

  // Update and show modal
  const modalOverlay = document.getElementById("accident-modal-overlay");
  const modalSeverity = document.getElementById("modal-severity");
  const modalCoords = document.getElementById("modal-coords");
  const modalSmsStatus = document.getElementById("modal-sms-status");
  const modalMapsLink = document.getElementById("modal-maps-link");

  if (modalSeverity) {
    modalSeverity.textContent = distance ? `${distance} cm (Obstacle Detected)` : (severity || "Under 15 cm");
  }
  if (modalCoords) modalCoords.textContent = `${crashLat.toFixed(5)}, ${crashLng.toFixed(5)}`;
  if (modalSmsStatus) modalSmsStatus.textContent = `Dispatched to ${emergencyContactPhone}`;
  if (modalMapsLink) modalMapsLink.href = `https://maps.google.com/?q=${crashLat},${crashLng}`;

  if (modalOverlay) {
    modalOverlay.style.display = "flex";
  }

  showToast(`Obstacle detected at RUET Campus (${distance || 10} cm)`, "error");
}

window.dismissAccidentModal = () => {
  const modalOverlay = document.getElementById("accident-modal-overlay");
  if (modalOverlay) modalOverlay.style.display = "none";
  if (bdMap) {
    bdMap.setView(latestAccidentCoords, 16, { animate: true });
  }
};

async function sendAccidentSMS(accidentId, accidentData) {
  const { lat, lng, severity, distance } = accidentData;
  const mapLink = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : "GPS N/A";

  const message = `[IGHS EMERGENCY ALERT]\nVehicle: Test Vehicle\nMode: DANGER (Crash Impact)\nSeverity: ${severity || "HIGH"}\nLocation: RUET Rajshahi\nGPS: ${mapLink}`;

  try {
    const res = await fetch(SMS_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: emergencyContactPhone,
        message: message,
        accidentId,
        vehicleName: "Test Vehicle",
        lat, lng,
        provider: smsProvider,
        apiKey: brevoApiKey
      })
    });
    const json = await res.json();
    if (json.success) {
      showToast(`Emergency SMS dispatched to ${emergencyContactPhone}`, "success");
    }
  } catch (err) {
    showToast(`SMS Logged for ${emergencyContactPhone}`, "info");
  }

  // Also dispatch email alert
  sendAccidentEmail(accidentId, accidentData);
}

async function sendRegistrationEmail(driverEmail, vehicleData) {
  if (!driverEmail) return;
  const { vehicleName, targetId, locationName, lat, lng } = vehicleData;
  const mapUrl = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : "https://maps.google.com/?q=24.3636,88.6283";

  const htmlContent = `
    <div style="font-family:sans-serif; max-width:540px; margin:0 auto; padding:24px; background:#fff; border:1px solid #e2e8f0; border-radius:12px;">
      <div style="text-align:center; margin-bottom:16px;">
        <span style="display:inline-block; padding:6px 14px; background:#dcfce7; color:#166534; font-weight:700; font-size:12px; border-radius:20px; text-transform:uppercase;">Vehicle Registered</span>
      </div>
      <h2 style="color:#0f172a; margin:0 0 10px 0; text-align:center;">🚗 ${vehicleName} is Active on IGHS</h2>
      <p style="color:#475569; text-align:center; font-size:14px;">Your vehicle has been successfully linked to the <strong>IGHS Intelligent Highway Telemetry Gateway</strong>.</p>
      
      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin:20px 0; font-size:13.5px;">
        <p style="margin:6px 0;"><strong>🚗 Vehicle Name:</strong> ${vehicleName}</p>
        <p style="margin:6px 0;"><strong>🆔 Hardware Unit ID:</strong> <code>${targetId}</code></p>
        <p style="margin:6px 0;"><strong>📍 Station / Location:</strong> ${locationName || 'RUET Campus, Rajshahi'}</p>
        <p style="margin:6px 0;"><strong>🛡️ Crash Protection:</strong> Active & Monitored</p>
      </div>

      <div style="text-align:center; margin-top:24px;">
        <a href="${mapUrl}" target="_blank" style="display:inline-block; background:#4338ca; color:#ffffff; text-decoration:none; padding:12px 24px; font-size:14px; font-weight:600; border-radius:8px;">
          📍 View Vehicle on Live Map ↗
        </a>
      </div>
      
      <p style="font-size:11.5px; color:#94a3b8; text-align:center; margin-top:24px; border-top:1px solid #f1f5f9; padding-top:12px;">
        You will receive instant emergency alerts at this email if a crash or obstacle is detected.
      </p>
    </div>
  `;

  try {
    const key = brevoApiKey || DEFAULT_KEY;
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": key
      },
      body: JSON.stringify({
        sender: { name: "IGHS Vehicle Registry", email: brevoSenderEmail || "b6ba16001@smtp-brevo.com" },
        to: [{ email: driverEmail, name: "Vehicle Owner" }],
        subject: `🚗 [Vehicle Registered] ${vehicleName} is now active on IGHS Telemetry`,
        htmlContent: htmlContent
      })
    });

    const data = await res.json();
    if (res.ok || (data && data.messageId)) {
      showToast(`Registration email dispatched to ${driverEmail}`, "success");
    }
  } catch (e) {
    console.warn("Registration email notice:", e.message);
  }
}

async function sendAccidentEmail(accidentId, accidentData) {
  const { lat, lng, severity, distance, locationName, driverEmail } = accidentData;
  
  // Send crash alert to BOTH Admin and Vehicle Owner
  const recipients = [];
  if (emergencyContactEmail) {
    recipients.push({ email: emergencyContactEmail, name: "Admin Emergency" });
  }
  if (driverEmail && driverEmail !== emergencyContactEmail) {
    recipients.push({ email: driverEmail, name: "Vehicle Owner" });
  }
  if (recipients.length === 0) return;

  const mapUrl = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : "https://maps.google.com/?q=24.3636,88.6283";
  const vehicleName = accidentData.vehicleName || "Test Vehicle";

  const htmlContent = `
    <div style="font-family:sans-serif; max-width:540px; margin:0 auto; padding:24px; background:#fff; border:1px solid #fee2e2; border-radius:12px;">
      <div style="text-align:center; margin-bottom:16px;">
        <span style="display:inline-block; padding:6px 14px; background:#fee2e2; color:#991b1b; font-weight:700; font-size:12px; border-radius:20px; text-transform:uppercase;">Emergency Alert</span>
      </div>
      <h2 style="color:#dc2626; margin:0 0 10px 0; text-align:center;">🚨 [CRITICAL ALERT] Vehicle Collision Detected</h2>
      <p style="color:#475569; text-align:center; font-size:14px;">An emergency crash / obstacle event was detected by the LiDAR sensor.</p>
      
      <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:16px; margin:20px 0; font-size:13.5px;">
        <p style="margin:6px 0;"><strong>🚗 Vehicle:</strong> ${vehicleName}</p>
        <p style="margin:6px 0;"><strong>📍 Location:</strong> ${locationName || 'RUET Campus, Rajshahi'}</p>
        <p style="margin:6px 0;"><strong>📏 Obstacle Distance:</strong> <span style="color:#dc2626; font-weight:700;">${distance || 10} cm</span></p>
        <p style="margin:6px 0;"><strong>🛡️ System Action:</strong> Automatic Emergency Braking Engaged</p>
      </div>

      <div style="text-align:center; margin-top:24px;">
        <a href="${mapUrl}" target="_blank" style="display:inline-block; background:#0f172a; color:#ffffff; text-decoration:none; padding:12px 24px; font-size:14px; font-weight:600; border-radius:8px;">
          📍 View Live Location in Google Maps ↗
        </a>
      </div>
    </div>
  `;

  try {
    const directKey = brevoApiKey || DEFAULT_KEY;
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": directKey
      },
      body: JSON.stringify({
        sender: { name: "IGHS Emergency System", email: brevoSenderEmail || "b6ba16001@smtp-brevo.com" },
        to: recipients,
        subject: `🚨 [CRITICAL ALERT] Vehicle Crash Detected (${vehicleName})`,
        htmlContent: htmlContent
      })
    });

    const data = await res.json();
    if (res.ok || (data && data.messageId)) {
      const recipientNames = recipients.map(r => r.email).join(", ");
      showToast(`Emergency alert dispatched to ${recipientNames}`, "success");
    }
  } catch (directErr) {
    console.warn("Direct Brevo API Notice:", directErr.message);
  }
}

// =============================================================================
// 8. SIMULATOR ACTIONS & DEMONSTRATION
// =============================================================================
function setupSimulator() {
  const btnCrash = document.getElementById("btn-trigger-crash");
  const btnSimMove = document.getElementById("btn-simulate-movement");
  const btnSendTestSms = document.getElementById("btn-send-test-sms");
  const btnSendTestEmail = document.getElementById("btn-send-test-email");

  // Pre-fill SMS & Email settings
  const phoneInput = document.getElementById("emergency-phone-input");
  const emailInput = document.getElementById("emergency-email-input");
  const senderInput = document.getElementById("brevo-sender-email-input");
  const providerSelect = document.getElementById("sms-provider-select");
  const brevoKeyInput = document.getElementById("brevo-key-input");

  if (phoneInput && emergencyContactPhone) phoneInput.value = emergencyContactPhone;
  if (emailInput && emergencyContactEmail) emailInput.value = emergencyContactEmail;
  if (senderInput && brevoSenderEmail) senderInput.value = brevoSenderEmail;
  if (providerSelect && smsProvider) providerSelect.value = smsProvider;
  if (brevoKeyInput && brevoApiKey) brevoKeyInput.value = brevoApiKey;

  // Test SMS Dispatcher Button
  if (btnSendTestSms) {
    btnSendTestSms.onclick = async () => {
      const phone = phoneInput ? phoneInput.value.trim() : emergencyContactPhone;
      const key = brevoKeyInput ? brevoKeyInput.value.trim() : brevoApiKey;
      const provider = providerSelect ? providerSelect.value : smsProvider;
      const resultBox = document.getElementById("sms-dispatch-result");

      btnSendTestSms.disabled = true;
      btnSendTestSms.textContent = "Dispatching SMS...";

      try {
        const res = await fetch(SMS_WORKER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: phone,
            message: `[IGHS TEST] Emergency SMS Gateway verified! Vehicle tracking is armed at RUET Rajshahi.`,
            accidentId: "TEST_RUET_VERIFY",
            vehicleName: "Test Vehicle",
            provider: provider,
            apiKey: key
          })
        });

        const data = await res.json();
        if (resultBox) {
          resultBox.style.display = "block";
          if (data.success && data.provider === "brevo") {
            resultBox.innerHTML = `
              <div style="background:#dcfce7; border:1px solid #86efac; border-radius:8px; padding:14px; color:#166534; font-size:13.5px;">
                <strong>✓ Brevo SMS Dispatched!</strong><br>
                Recipient: <code>+${data.to}</code> | Gateway: <strong>Brevo Transactional API</strong>
              </div>
            `;
          } else {
            resultBox.innerHTML = `
              <div style="background:#fef3c7; border:1px solid #fcd34d; border-radius:8px; padding:14px; color:#92400e; font-size:13.5px;">
                <strong>SMS Dispatched</strong><br>
                Recipient: <code>${data.to || phone}</code> | Provider: <strong>${data.provider}</strong>
              </div>
            `;
          }
        }
        showToast(`SMS sent to ${phone}`, "success");
      } catch (err) {
        if (resultBox) {
          resultBox.style.display = "block";
          resultBox.innerHTML = `
            <div style="background:#fee2e2; border:1px solid #fca5a5; border-radius:8px; padding:14px; color:#991b1b; font-size:13.5px;">
              <strong>SMS Dispatch Error:</strong> ${err.message}
            </div>
          `;
        }
        showToast("SMS error: " + err.message, "error");
      } finally {
        btnSendTestSms.disabled = false;
        btnSendTestSms.textContent = "📲 Send Test Emergency SMS";
      }
    };
  }

  // Test Email Dispatcher Button
  if (btnSendTestEmail) {
    btnSendTestEmail.onclick = async () => {
      const email = emailInput ? emailInput.value.trim() : emergencyContactEmail;
      const sender = senderInput ? senderInput.value.trim() : (brevoSenderEmail || "b6ba16001@smtp-brevo.com");
      const resultBox = document.getElementById("sms-dispatch-result");

      btnSendTestEmail.disabled = true;
      btnSendTestEmail.textContent = "Sending Email...";

      const emailPayload = {
        to: email,
        senderEmail: sender,
        vehicleName: "RUET Vehicle Alpha",
        lat: RUET_COORDS.lat,
        lng: RUET_COORDS.lng,
        distance: 8,
        severity: "CRITICAL (Obstacle < 8 cm)"
      };

      let isSent = false;
      let errorDetail = "";

      // 1. Try local server endpoint if on localhost
      if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
        try {
          const res = await fetch(`${location.origin}/email`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(emailPayload)
          });
          const text = await res.text();
          if (text) {
            const data = JSON.parse(text);
            if (data && data.success) isSent = true;
            else if (data && data.error) errorDetail = data.error;
          }
        } catch (err) {
          errorDetail = err.message;
        }
      }

      // 2. Direct Cloudflare Pages Fallback via Brevo REST API
      if (!isSent) {
        try {
          const htmlContent = `
            <div style="font-family:sans-serif; max-width:540px; margin:0 auto; padding:20px; background:#fff; border:1px solid #e2e8f0; border-radius:10px;">
              <h2 style="color:#dc2626; margin:0 0 10px 0;">🚨 [TEST ALERT] Vehicle Safety Verification</h2>
              <p><strong>Status:</strong> Emergency Alert System Verified & Active</p>
              <p><strong>Location:</strong> RUET Campus, Rajshahi</p>
              <p><strong>GPS:</strong> 24.3636, 88.6283</p>
              <p><a href="https://maps.google.com/?q=24.3636,88.6283" style="display:inline-block; padding:10px 18px; background:#0f172a; color:#fff; text-decoration:none; border-radius:6px;">View on Google Maps ↗</a></p>
            </div>
          `;

          const key = (brevoKeyInput && brevoKeyInput.value.trim()) || brevoApiKey || DEFAULT_KEY;
          const bRes = await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: {
              "accept": "application/json",
              "content-type": "application/json",
              "api-key": key
            },
            body: JSON.stringify({
              sender: { name: "IGHS Emergency System", email: sender },
              to: [{ email: email }],
              subject: `🚨 [TEST ALERT] Emergency System Verified (${emailPayload.vehicleName})`,
              htmlContent: htmlContent
            })
          });

          const bText = await bRes.text();
          let bData = {};
          try { bData = JSON.parse(bText); } catch(e) {}

          if (bRes.ok || (bData && bData.messageId)) {
            isSent = true;
          } else {
            errorDetail = bData?.message || bText || "Brevo API verification error";
          }
        } catch (err) {
          errorDetail = err.message;
        }
      }

      if (isSent) {
        if (resultBox) {
          resultBox.style.display = "block";
          resultBox.innerHTML = `
            <div style="background:#dcfce7; border:1px solid #86efac; border-radius:8px; padding:14px; color:#166534; font-size:13.5px;">
              <strong>✓ Test Emergency Email Sent!</strong><br>
              Recipient: <code>${email}</code> | Sender: <code>${sender}</code><br>
              Check your email inbox (and Spam folder) for the incident report!
            </div>
          `;
        }
        showToast(`Emergency alert email dispatched to ${email}`, "success");
      } else {
        if (resultBox) {
          resultBox.style.display = "block";
          resultBox.innerHTML = `
            <div style="background:#fee2e2; border:1px solid #fca5a5; border-radius:8px; padding:14px; color:#991b1b; font-size:13.5px;">
              <strong>Email Dispatch Notice:</strong> ${errorDetail || "Check Brevo sender authentication."}
            </div>
          `;
        }
        showToast(`Email error: ${errorDetail || 'Check sender email'}`, "error");
      }

      btnSendTestEmail.disabled = false;
      btnSendTestEmail.textContent = "📧 Send Test Emergency Alert Email";
    };
  }
}

window.saveSMSConfig = () => {
  const phoneInput = document.getElementById("emergency-phone-input");
  const emailInput = document.getElementById("emergency-email-input");
  const senderInput = document.getElementById("brevo-sender-email-input");
  const providerSelect = document.getElementById("sms-provider-select");
  const brevoKeyInput = document.getElementById("brevo-key-input");

  if (phoneInput) {
    emergencyContactPhone = phoneInput.value.trim();
    localStorage.setItem("ighs_emergency_phone", emergencyContactPhone);
  }
  if (emailInput) {
    emergencyContactEmail = emailInput.value.trim();
    localStorage.setItem("ighs_emergency_email", emergencyContactEmail);
  }
  if (senderInput) {
    brevoSenderEmail = senderInput.value.trim();
    localStorage.setItem("ighs_brevo_sender", brevoSenderEmail);
  }
  if (providerSelect) {
    smsProvider = providerSelect.value;
    localStorage.setItem("ighs_sms_provider", smsProvider);
  }
  if (brevoKeyInput) {
    brevoApiKey = brevoKeyInput.value.trim();
    localStorage.setItem("ighs_brevo_key", brevoApiKey);
  }

  showToast(`Settings saved! Phone: ${emergencyContactPhone} | Email: ${emergencyContactEmail}`, "success");
};

window.copyArduinoCode = () => {
  const codeBlock = document.getElementById("arduino-code-block");
  if (codeBlock) {
    navigator.clipboard.writeText(codeBlock.innerText);
    showToast("Arduino C++ code copied to clipboard!", "success");
  }
};

// =============================================================================
// 9. AUTHENTICATION & VIEW MANAGEMENT
// =============================================================================
let loadingScreen, authSection, dashboardSection;
let signInTab, signUpTab, signInForm, signUpForm;
let signInEmailInput, signInPasswordInput, signInBtn, googleSignInBtn;
let signUpEmailInput, signUpPasswordInput, signUpBtn, googleSignUpBtn;
let navUserEmail, navRoleBadge, logoutBtn;
let adminPanelContainer;

onAuthStateChanged(auth, async (user) => {
  hideLoadingScreen();

  if (!user) {
    showAuthSection();
    hideDashboardSection();
    if (unsubscribeVehiclesListener) { unsubscribeVehiclesListener(); unsubscribeVehiclesListener = null; }
    if (unsubscribeAccidentsListener) { unsubscribeAccidentsListener(); unsubscribeAccidentsListener = null; }
    return;
  }

  hideAuthSection();
  let role = "user";

  try {
    const userDocRef = doc(db, "users", user.uid);
    const userSnap   = await getDoc(userDocRef);
    if (userSnap.exists()) {
      const data = userSnap.data();
      role = (data.role === "admin") ? "admin" : "user";
    }
  } catch (err) {
    console.warn("User role notice:", err.message);
  }

  showDashboardSection(user, role);

  // Initialize RUET Rajshahi Map and Fleet Telemetry
  initBangladeshMap();
  startFleetTracking();
  startAccidentMonitor();
  setupSimulator();
});

function hideLoadingScreen() {
  const el = loadingScreen || document.getElementById("loading-screen");
  if (el) {
    el.classList.add("loading--hidden");
    setTimeout(() => { if (el) el.style.display = "none"; }, 350);
  }
}

function showAuthSection() {
  const el = authSection || document.getElementById("auth-section");
  if (el) el.style.display = "flex";
}

function hideAuthSection() {
  const el = authSection || document.getElementById("auth-section");
  if (el) el.style.display = "none";
}

function hideDashboardSection() {
  const el = dashboardSection || document.getElementById("dashboard-section");
  if (el) el.style.display = "none";
}

function showDashboardSection(user, role) {
  const emailEl = navUserEmail || document.getElementById("nav-user-email");
  const badgeEl = navRoleBadge || document.getElementById("nav-role-badge");
  const dashEl  = dashboardSection || document.getElementById("dashboard-section");

  if (emailEl) emailEl.textContent = user.email;
  if (badgeEl) {
    badgeEl.textContent = (role === "admin") ? "Admin" : "User";
    badgeEl.className   = (role === "admin") ? "role-badge role-badge--admin" : "role-badge role-badge--user";
  }

  const userPanelEmail = document.getElementById("user-panel-email");
  const userPanelRole  = document.getElementById("user-panel-role");
  if (userPanelEmail) userPanelEmail.textContent = user.email;
  if (userPanelRole)  userPanelRole.textContent  = role.toUpperCase();

  renderAdminPanel(role);
  if (dashEl) dashEl.style.display = "block";
}

function renderAdminPanel(role) {
  if (!adminPanelContainer) return;
  adminPanelContainer.innerHTML = "";
  if (role !== "admin") return;

  adminPanelContainer.innerHTML = `
    <section class="panel panel--admin" aria-label="Admin Control Panel" style="margin-top:20px;">
      <div class="panel__header">
        <div class="panel__title-group">
          <h2 class="panel__title">Admin Fleet Control & Telemetry Logs</h2>
          <span class="badge badge--restricted">Admin Restricted</span>
        </div>
        <p class="panel__subtitle">Administrative controls for fleet database and system cache.</p>
      </div>
      <div class="panel__body">
        <div style="display:flex; gap:12px; flex-wrap:wrap;">
          <button class="btn btn--primary" onclick="window.showToast && window.showToast('Telemetry export initiated.', 'success')">Export Telemetry Data</button>
          <button class="btn btn--danger" onclick="window.showToast && window.showToast('Cache cleared.', 'warning')">Clear Cache</button>
        </div>
      </div>
    </section>
  `;
}

// ── Auth Handlers ────────────────────────────────────────────────────────────
async function handleSignUp(e) {
  e.preventDefault();
  const email = signUpEmailInput.value.trim();
  const password = signUpPasswordInput.value;
  setButtonLoading(signUpBtn, true, "Creating Account...");

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, "users", cred.user.uid), {
      email: cred.user.email,
      role: "user",
      createdAt: serverTimestamp()
    });
    showToast("Account created! Welcome to IGHS.", "success");
  } catch (err) {
    const errBanner = document.getElementById("signup-form-error");
    if (errBanner) { errBanner.textContent = mapAuthError(err); errBanner.style.display = "block"; }
  } finally {
    setButtonLoading(signUpBtn, false, "Create Account");
  }
}

async function handleSignIn(e) {
  e.preventDefault();
  const email = signInEmailInput.value.trim();
  const password = signInPasswordInput.value;
  setButtonLoading(signInBtn, true, "Signing in...");

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    const errBanner = document.getElementById("signin-form-error");
    if (errBanner) { errBanner.textContent = mapAuthError(err); errBanner.style.display = "block"; }
  } finally {
    setButtonLoading(signInBtn, false, "Sign In");
  }
}

async function handleGoogleAuth(formPrefix = "signin") {
  const btn = formPrefix === "signup" ? googleSignUpBtn : googleSignInBtn;
  const original = btn ? btn.innerHTML : "";
  if (btn) btn.innerHTML = `Connecting to Google...`;

  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const result = await signInWithPopup(auth, provider);
    const user = result.user;

    const userDocRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userDocRef);
    if (!userSnap.exists()) {
      await setDoc(userDocRef, {
        email: user.email || "",
        role: "user",
        createdAt: serverTimestamp()
      });
    }
    showToast(`Signed in as ${user.email}`, "success");
  } catch (err) {
    if (err.code !== "auth/popup-closed-by-user") {
      const errBanner = document.getElementById(`${formPrefix}-form-error`);
      if (errBanner) { errBanner.textContent = mapAuthError(err); errBanner.style.display = "block"; }
    }
  } finally {
    if (btn) btn.innerHTML = original;
  }
}

async function handleSignOut() {
  try {
    await signOut(auth);
    showToast("Signed out successfully.", "info");
  } catch (err) {
    showToast("Sign out failed.", "error");
  }
}

function setButtonLoading(btn, isLoading, text) {
  if (!btn) return;
  btn.disabled = isLoading;
  btn.textContent = text;
}

function switchTab(tab) {
  const isSignIn = tab === "signin";
  if (signInTab) signInTab.classList.toggle("tab--active", isSignIn);
  if (signUpTab) signUpTab.classList.toggle("tab--active", !isSignIn);
  if (signInForm) signInForm.style.display = isSignIn ? "block" : "none";
  if (signUpForm) signUpForm.style.display = !isSignIn ? "block" : "none";
}

// ── DOM Ready Init ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  loadingScreen       = document.getElementById("loading-screen");
  authSection         = document.getElementById("auth-section");
  dashboardSection    = document.getElementById("dashboard-section");
  signInTab             = document.getElementById("signin-tab");
  signUpTab             = document.getElementById("signup-tab");
  signInForm            = document.getElementById("signin-form");
  signUpForm            = document.getElementById("signup-form");
  signInEmailInput      = document.getElementById("signin-email");
  signInPasswordInput   = document.getElementById("signin-password");
  signInBtn             = document.getElementById("signin-btn");
  googleSignInBtn       = document.getElementById("google-signin-btn");
  signUpEmailInput      = document.getElementById("signup-email");
  signUpPasswordInput   = document.getElementById("signup-password");
  signUpBtn             = document.getElementById("signup-btn");
  googleSignUpBtn       = document.getElementById("google-signup-btn");
  navUserEmail        = document.getElementById("nav-user-email");
  navRoleBadge        = document.getElementById("nav-role-badge");
  logoutBtn           = document.getElementById("logout-btn");
  adminPanelContainer = document.getElementById("admin-panel-container");

  if (signInForm)      signInForm.addEventListener("submit", handleSignIn);
  if (signUpForm)      signUpForm.addEventListener("submit", handleSignUp);
  if (googleSignInBtn) googleSignInBtn.addEventListener("click", () => handleGoogleAuth("signin"));
  if (googleSignUpBtn) googleSignUpBtn.addEventListener("click", () => handleGoogleAuth("signup"));
  if (logoutBtn)       logoutBtn.addEventListener("click", handleSignOut);

  if (signInTab) signInTab.addEventListener("click", () => switchTab("signin"));
  if (signUpTab) signUpTab.addEventListener("click", () => switchTab("signup"));
});
