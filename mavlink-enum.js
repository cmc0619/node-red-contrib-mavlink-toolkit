module.exports = function(RED) {
  function MavlinkEnumNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.schemaCfg = RED.nodes.getNode(config.schema);
    node.enumName = config.enumName || "";
    node.enumKey = config.enumKey || "";
    node.keySource = config.keySource || "config";
    node.keyField = config.keyField || "payload";

    node.on("input", (msg, send, done) => {
      try {
        const schema = node.schemaCfg?.getSchema();
        if (!schema) throw new Error("No schema loaded");
        const enumName = node.enumName || msg.enumName;
        if (!enumName) throw new Error("No enum selected");
        const members = schema.enums[enumName] || [];
        let key = node.enumKey;
        if (node.keySource !== "config") {
          key = RED.util.getMessageProperty(msg, node.keyField);
        }
        if (!key) throw new Error("No enum key provided");
        const found = members.find(m => m.key === key);
        if (!found) throw new Error(`Key "${key}" not found in enum "${enumName}"`);

        msg.mavlink = msg.mavlink || {};
        msg.mavlink.enum = enumName;
        msg.mavlink.key = key;
        msg.mavlink.value = found.value;
        msg.payload = found.value;
        send(msg); done();
      } catch (e) { node.status({fill:"red",shape:"dot",text:e.message}); done(e); }
    });
  }

  // Editor endpoints use the schema config's admin endpoints (already defined in schema node)
  RED.nodes.registerType("mavlink-enum", MavlinkEnumNode);
};

