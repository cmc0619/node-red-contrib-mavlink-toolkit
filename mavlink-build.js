module.exports = function(RED) {
  const helpers = require("./lib/mavlink-helpers");

  function MavlinkBuildNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.schemaCfg = RED.nodes.getNode(config.schema);
    node.messageName = config.messageName || "";
    node.sysid = Number(config.sysid || 1);
    node.compid = Number(config.compid || 1);

    let seq = 0;

    node.on("input", (msg, send, done) => {
      try {
        const schema = node.schemaCfg?.getSchema();
        if (!schema) throw new Error("No schema loaded");
        const messages = schema.messages;

        const messageName = node.messageName || msg.messageName;
        if (!messageName) throw new Error("No message selected");
        const def = messages[messageName];
        if (!def) throw new Error(`Message "${messageName}" not in schema`);

        const payloadObj = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
        const payload = helpers.packPayload(def, payloadObj);

        const frame = helpers.buildFrameV2(def, payload, {
          seq: seq++ & 0xFF,
          sysid: msg.sysid ?? node.sysid,
          compid: msg.compid ?? node.compid,
          incompatFlags: msg.incompatFlags ?? 0,
          compatFlags: msg.compatFlags ?? 0
        });

        msg.payload = frame;
        msg.mavlink = {
          name: messageName, id: def.id, seq: (seq-1)&0xFF,
          sysid: msg.sysid ?? node.sysid, compid: msg.compid ?? node.compid
        };
        send(msg); done();
      } catch (e) { node.status({fill:"red",shape:"dot",text:e.message}); done(e); }
    });
  }

  RED.nodes.registerType("mavlink-build", MavlinkBuildNode);
};

