module.exports = function(RED) {
  const dgram = require("dgram");
  let SerialPort;
  try { SerialPort = require("serialport").SerialPort; } catch(_) {}

  function MavlinkIONode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.mode = config.mode || "udp"; // "udp" | "serial"
    node.localPort = Number(config.localPort || 14550);
    node.remoteHost = config.remoteHost || "127.0.0.1";
    node.remotePort = Number(config.remotePort || 14551);
    node.serialPath = config.serialPath || "/dev/ttyUSB0";
    node.baud = Number(config.baud || 57600);

    let udpSock = null, serial = null;

    function handleIncoming(buf) {
      const msg = { topic: "mavlink/raw", payload: Buffer.from(buf) };
      node.send(msg);
    }

    if (node.mode === "udp") {
      udpSock = dgram.createSocket("udp4");
      udpSock.on("message", handleIncoming);
      udpSock.on("error", err => node.error(err));
      udpSock.bind(node.localPort, ()=> node.status({ fill:"green", shape:"dot", text:`udp ${node.localPort} ↔ ${node.remoteHost}:${node.remotePort}`}));
    } else if (node.mode === "serial") {
      if (!SerialPort) {
        node.status({ fill:"red", shape:"dot", text:"serialport module not installed" });
        node.error("Install optional dependency 'serialport' to use serial mode.");
      } else {
        serial = new SerialPort({ path: node.serialPath, baudRate: node.baud });
        serial.on("data", handleIncoming);
        serial.on("open", ()=> node.status({ fill:"green", shape:"dot", text:`serial ${node.serialPath} @ ${node.baud}` }));
        serial.on("error", err => node.error(err));
      }
    }

    node.on("input", (msg, send, done) => {
      try {
        const buf = Buffer.isBuffer(msg.payload) ? msg.payload : Buffer.from(msg.payload);
        if (node.mode === "udp") {
          udpSock.send(buf, node.remotePort, node.remoteHost);
        } else if (serial) {
          serial.write(buf);
        }
        done();
      } catch (e) { done(e); }
    });

    node.on("close", (done) => {
      try {
        if (udpSock) udpSock.close();
        if (serial) serial.close(()=>{});
      } catch(_) {}
      done();
    });
  }

  RED.nodes.registerType("mavlink-io", MavlinkIONode);
};

