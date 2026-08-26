// =============================================================================
// IGHS Live Telemetry Streamer for NodeMCU ESP8266
// Pure Real-Time Distance & Status Sync (SAFE / WARN / DANGER)
// Target Location: RUET Campus, Rajshahi (24.3636, 88.6283)
// =============================================================================

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <SoftwareSerial.h>

// SoftwareSerial on original pins D2 & D3
SoftwareSerial nanoSerial(D2, D3); // RX = D2, TX = D3

// ── 1. WiFi Hotspot Credentials ──────────────────────────────────────────────
const char* ssid     = "iPhone (2)";
const char* password = "ratul12345";

// ── 2. Vehicle Identity (Matches "Device / Unit ID" on Website) ───────────────
const char* vehicleId   = "esp32-ruet-01"; // Change to "esp32-ruet-02", etc. for other cars
const char* vehicleName = "RUET Test Vehicle";

// ── 3. Firebase Cloud Database Endpoint ──────────────────────────────────────
const char* firestoreBase = "https://firestore.googleapis.com/v1/projects/ighs-9a0f1/databases/(default)/documents/";

// Telemetry & Safety State
int currentDistance   = 100;
int lastSentDistance  = -1;
String currentStatus  = "SAFE";
String lastSentStatus = "";

const double RUET_LAT = 24.3636;
const double RUET_LNG = 88.6283;

unsigned long lastTelemetryPush = 0;

void setup() {
  Serial.begin(9600);
  nanoSerial.begin(9600);
  nanoSerial.setTimeout(20);

  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);

  Serial.println("\n==========================================");
  Serial.println("  IGHS Live Telemetry Streamer Starting...");
  Serial.println("==========================================");

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi: ");
  Serial.println(ssid);

  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }

  Serial.printf("\n[ONLINE] Connected to '%s'! IP: %s\n", ssid, WiFi.localIP().toString().c_str());
  digitalWrite(LED_BUILTIN, LOW);

  sendTelemetryToWebsite(RUET_LAT, RUET_LNG, currentDistance, "SAFE");
}

void loop() {
  yield();

  bool hasUpdate = false;

  // 1. Read Live Serial Stream from Arduino Nano
  while (nanoSerial.available() > 0) {
    String line = nanoSerial.readStringUntil('\n');
    line.trim();

    int dPos = line.indexOf("D:");
    if (dPos >= 0) {
      int commaPos = line.indexOf(',', dPos);
      if (commaPos > dPos + 2) {
        String distStr = line.substring(dPos + 2, commaPos);
        distStr.trim();
        int dist = distStr.toInt();

        String statusStr = line.substring(commaPos + 1);
        statusStr.replace("S:", "");
        statusStr.trim();
        statusStr.toUpperCase();

        if (dist >= 2 && dist <= 400) {
          currentDistance = dist;

          // Direct Status Calculation from Sensor Distance & Nano Status
          if (dist <= 15 || statusStr.indexOf("DANGER") >= 0 || statusStr.indexOf("EMERGENCY") >= 0) {
            currentStatus = "DANGER";
          } else if (dist <= 30 || statusStr.indexOf("WARN") >= 0) {
            currentStatus = "WARN";
          } else {
            currentStatus = "SAFE";
          }

          hasUpdate = true;
        }
      }
    }
  }

  // 2. Real-Time Instant Cloud Push if Status or Distance Changes
  if (hasUpdate) {
    bool stateChanged = (currentStatus != lastSentStatus);
    bool distChanged  = (abs(currentDistance - lastSentDistance) >= 3);

    if (stateChanged || distChanged) {
      Serial.printf(">>> [STREAM] Distance: %d cm | Mode: %s\n", currentDistance, currentStatus.c_str());
      sendTelemetryToWebsite(RUET_LAT, RUET_LNG, currentDistance, currentStatus);
      lastSentDistance  = currentDistance;
      lastSentStatus    = currentStatus;
      lastTelemetryPush = millis();
    }
  }

  // 3. Heartbeat Keep-Alive (every 1.5s)
  if (millis() - lastTelemetryPush >= 1500) {
    lastTelemetryPush = millis();
    sendTelemetryToWebsite(RUET_LAT, RUET_LNG, currentDistance, currentStatus);
  }
}

// -----------------------------------------------------------------------------
// Send Live Telemetry to Website Dashboard
// -----------------------------------------------------------------------------
void sendTelemetryToWebsite(double lat, double lng, int distance, String status) {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(1000);

  HTTPClient http;
  String url = String(firestoreBase) + "vehicles/" + String(vehicleId);
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");

  String json = "{\"fields\":{"
                "\"vehicleName\":{\"stringValue\":\"Test Vehicle\"},"
                "\"lat\":{\"doubleValue\":" + String(lat, 5) + "},"
                "\"lng\":{\"doubleValue\":" + String(lng, 5) + "},"
                "\"distance\":{\"integerValue\":" + String(distance) + "},"
                "\"status\":{\"stringValue\":\"" + status + "\"},"
                "\"locationName\":{\"stringValue\":\"RUET Campus, Rajshahi\"}"
                "}}";

  int httpCode = http.PATCH(json);
  if (httpCode == 200) {
    Serial.printf(">>> [SYNC 200] Distance: %d cm | Mode: %s\n", distance, status.c_str());
  }
  http.end();
}
