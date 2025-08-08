module.exports = function(RED) {
  const { scanFramesV2, crcX25, crcAccumulate } = require("./lib/mavlink-helpers");

  function MavlinkParseNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.schemaCfg = RED.nodes.getNode(config.schema);
    if (!node.schemaCfg) {
      node.status({ fill:"red", shape:"dot", text:"no schema" });
      node.error("mavlink-parse: schema config missing");
      return;
    }
    const messages = node.schemaCfg.getMessages();

    node.on("input", (msg, send, done) => {
      try {
        const buf = Buffer.isBuffer(msg.payload) ? msg.payload : Buffer.from(msg.payload);
        for (const f of scanFramesV2(buf)) {
          const frame = f.frameBuf;
          const len = frame[1];
          const incompatFlags = frame[2], compatFlags = frame[3];
          const seq = frame[4], sysid = frame[5], compid = frame[6];
          const msgid = frame[7] | (frame[8]<<8) | (frame[9]<<16);
          const payload = frame.subarray(10, 10+len);
          const crcRx = frame.readUInt16LE(10+len);

          // Try to find message definition
          const msgDef = Object.values(messages).find(m => m.id === msgid);
          let checksumOk = false;
          if (msgDef) {
            const crcData = Buffer.concat([ frame.subarray(1,10), payload ]);
            let crc = crcX25(crcData);
            crc = crcAccumulate(msgDef.crc & 0xff, crc);
            checksumOk = (crc === crcRx);
          }

          const out = {
            _raw: frame,
            payloadRaw: payload,
            mavlink: { msgid, seq, sysid, compid, incompatFlags, compatFlags, checksumOk }
          };

          if (msgDef && checksumOk) {
            // Decode payload using schema
            const helpers = require("./lib/mavlink-helpers");
            try {
              const obj = helpers.unpackPayload(msgDef, payload);
              out.mavlink.name = Object.keys(messages).find(n => messages[n].id === msgid);
              out.payload = obj; // NOTE: we override payload with parsed object
            } catch (e) {
              out.payload = payload; // fall back
            }
          } else {
            out.payload = payload; // unknown/failed
          }

          send(RED.util.cloneMessage(out));
        }
        done();
      } catch (e) { node.error(e, msg); done(e); }
    });
  }

  RED.nodes.registerType("mavlink-parse", MavlinkParseNode);
};

