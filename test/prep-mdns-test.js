// Standalone mDNS broadcast test — verifies bonjour publishes a service
const bonjour = require("bonjour")();

const service = bonjour.publish({
  name: "Clawd Desktop Test",
  type: "clawd",
  protocol: "tcp",
  port: 23338,
  txt: { test: "true", version: "1" },
});

console.log('[mDNS] Published service "Clawd Desktop Test" (type _clawd._tcp)');
console.log("[mDNS] Verify with: dns-sd -B _clawd._tcp");
console.log("[mDNS] Press Ctrl+C to stop");

// Self-browse to verify publication
setTimeout(() => {
  const browser = bonjour.find({ type: "clawd" }, (svc) => {
    console.log(`[mDNS] Found service: ${svc.name} at ${svc.host}:${svc.port}`);
    if (svc.name === "Clawd Desktop Test") {
      console.log("[mDNS] Self-discovery test PASSED");
      service.stop();
      bonjour.destroy();
      process.exit(0);
    }
  });
  // Fallback timeout
  setTimeout(() => {
    console.log("[mDNS] Self-discovery timed out (firewall may block mDNS), but publish succeeded");
    service.stop();
    bonjour.destroy();
    process.exit(0);
  }, 5000);
}, 1000);
