module.exports = function(RED) {
  const dgram = require("dgram");
  const { scanFramesV2 } = require("./lib/mavlink-helpers");
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
    let rxBuf = Buffer.alloc(0);

    function handleIncoming(chunk) {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      let lastEnd = 0;
      try {
        for (const f of scanFramesV2(rxBuf)) {
          lastEnd = f.end;
          try {
            const frame = Buffer.from(f.frameBuf);
            if (frame.length < 10) throw new Error("frame too short");
            const msgid = frame[7] | (frame[8] << 8) | (frame[9] << 16);
            const msg = { topic: "mavlink/raw", payload: frame };
            // route HEARTBEAT (msgid 0) to output[0]; everything else to output[1]
            if (msgid === 0) node.send([msg, null]);
            else node.send([null, msg]);
          } catch (e) {
            node.warn(`dropping MAVLink frame: ${e.message}`);
          }
        }
      } catch (e) {
        node.warn(`error scanning MAVLink data: ${e.message}`);
        rxBuf = Buffer.alloc(0);
        return;
      }
      if (lastEnd > 0) {
        rxBuf = rxBuf.subarray(lastEnd);
      } else if (rxBuf.length > 2048) {
        const idx = rxBuf.lastIndexOf(0xFD);
        rxBuf = idx >= 0 ? rxBuf.subarray(idx) : Buffer.alloc(0);
        node.warn("discarding unparseable MAVLink data");
      }
    }

    if (node.mode === "udp") {
      udpSock = dgram.createSocket("udp4");
      udpSock.on("message", handleIncoming);
      udpSock.on("error", err => node.error(err));
      udpSock.bind(node.localPort, () =>
        node.status({ fill: "green", shape: "dot", text: `udp ${node.localPort} ↔ ${node.remoteHost}:${node.remotePort}` })
      );
    } else if (node.mode === "serial") {
      if (!SerialPort) {
        node.status({ fill:"red", shape:"dot", text:"serialport module not installed" });
        node.error("Install optional dependency 'serialport' to use serial mode.");
      } else {
        serial = new SerialPort({ path: node.serialPath, baudRate: node.baud });
        serial.on("data", handleIncoming);
        serial.on("open", () =>
          node.status({ fill:"green", shape:"dot", text:`serial ${node.serialPath} @ ${node.baud}` })
        );
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
        if (serial) serial.close(() => {});
      } catch (_) {}
      done();
    });
  }

  RED.nodes.registerType("mavlink-io", MavlinkIONode);
};

