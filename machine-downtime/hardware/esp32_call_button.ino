// Optional physical call button for one sewing machine (ESP32 + push button + LED).
// Each press calls  POST http://<server>:3000/api/machines/<MACHINE_ID>/press
//   1st press: operator calls the mechanic (waiting time starts)
//   2nd press: mechanic arrived (repair time starts)
//   3rd press: job done (mechanic then selects the reason on the portal / phone)
// Wiring: button between GPIO 0 and GND, LED (+ resistor) on GPIO 2.

#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID   = "FACTORY-WIFI";
const char* WIFI_PASS   = "password";
const char* SERVER      = "http://192.168.1.10:3000";
const char* MACHINE_ID  = "MC-01";
const int   BUTTON_PIN  = 0;
const int   LED_PIN     = 2;

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void blink(int times) {
  for (int i = 0; i < times; i++) { digitalWrite(LED_PIN, HIGH); delay(150); digitalWrite(LED_PIN, LOW); delay(150); }
}

void loop() {
  if (digitalRead(BUTTON_PIN) == LOW) {
    delay(50);                                   // debounce
    if (digitalRead(BUTTON_PIN) == LOW && WiFi.status() == WL_CONNECTED) {
      HTTPClient http;
      http.begin(String(SERVER) + "/api/machines/" + MACHINE_ID + "/press");
      int code = http.POST("");
      String body = http.getString();
      http.end();
      // LED feedback: 1 blink = called, 2 = mechanic arrived, 3 = job done, long = error
      if (code != 200)                         { digitalWrite(LED_PIN, HIGH); delay(1500); digitalWrite(LED_PIN, LOW); }
      else if (body.indexOf("\"call\"") > 0)   blink(1);
      else if (body.indexOf("\"arrive\"") > 0) blink(2);
      else                                     blink(3);
    }
    while (digitalRead(BUTTON_PIN) == LOW) delay(10); // wait for release
  }
}
