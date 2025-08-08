module.exports = function(RED) {
  const fs = require("fs");
  const path = require("path");
  const { XMLParser } = require("fast-xml-parser");
  const mkdirp = require("mkdirp");
  const crypto = require("crypto");

  function sha1(s) { return crypto.createHash("sha1").update(s).digest("hex"); }

  function parseDialects(entryXmlPaths) {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", allowBooleanAttributes: true });
    const seen = new Set();
    const enumsMap = new Map();   // name -> [{key,value,comment,isBitmask}]
    const msgsMap  = new Map();   // name -> {id, crc, fields: [...]}

    function loadOne(absPath) {
      const abs = path.resolve(absPath);
      if (seen.has(abs)) return;
      seen.add(abs);
      const xml = fs.readFileSync(abs, "utf8");
      const doc = parser.parse(xml).mavlink;

      const includes = []
        .concat(doc.include || [])
        .map(i => path.resolve(path.dirname(abs), i["@_file"]))
        .filter(Boolean);

      // Recurse includes first
      for (const inc of includes) loadOne(inc);

      // Enums
      const enums = doc.enums?.enum ? [].concat(doc.enums.enum) : [];
      for (const e of enums) {
        const name = e["@_name"];
        const isBitmask = (e["@_bitmask"] === true || e["@_bitmask"] === "true");
        const entries = (e.entry ? [].concat(e.entry) : []).map(en => ({
          key: en["@_name"],
          value: Number(en["@_value"]),
          comment: (en.description && (en.description["#text"] || en.description)) ? String(en.description["#text"] || en.description).trim() : "",
          isBitmask
        }));
        if (!enumsMap.has(name)) enumsMap.set(name, entries);
        else enumsMap.set(name, [...enumsMap.get(name), ...entries]);
      }

      // Messages
      const messages = doc.messages?.message ? [].concat(doc.messages.message) : [];
      for (const m of messages) {
        const name = m["@_name"];
        const id   = Number(m["@_id"]);
        const crc  = Number(m["@_crc"] ?? m["@_crc_extra"] ?? 0); // crc attr name varies in some forks
        const fields = (m.field ? [].concat(m.field) : []).map(f => {
          // f can be { '@_name','@_type','#text','@_enum','@_units','@_length','@_array_length', ...}
          const fname = f["@_name"] || (typeof f["#text"] === "string" ? f["#text"].trim() : "");
          return {
            name: fname,
            type: f["@_type"],
            enum: f["@_enum"],
            units: f["@_units"],
            min: f["@_min"] !== undefined ? Number(f["@_min"]) : undefined,
            max: f["@_max"] !== undefined ? Number(f["@_max"]) : undefined,
            arrayLen: f["@_length"] ? Number(f["@_length"]) : (f["@_array_length"] ? Number(f["@_array_length"]) : undefined)
          };
        });
        msgsMap.set(name, { id, crc, fields });
      }
    }

    for (const p of entryXmlPaths) loadOne(p);

    return {
      enums: Object.fromEntries(enumsMap),
      messages: Object.fromEntries(msgsMap)
    };
  }

  function saveSchema(cacheDir, dialectName, schema) {
    mkdirp.sync(cacheDir);
    const outPath = path.join(cacheDir, `${dialectName}.schema.json`);
    fs.writeFileSync(outPath, JSON.stringify(schema, null, 2), "utf8");
    return outPath;
  }

  function loadSchemaFile(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  function anyMtime(paths) {
    return Math.max(...paths.map(p => fs.statSync(p).mtimeMs));
  }

  function MavlinkSchemaNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.dialectName = config.dialectName || "dialect";
    node.xmlPathsRaw = config.xmlPaths || "";
    node.cacheDir = config.cacheDir || path.join(RED.settings.userDir || ".", "mavlink-cache");
    node.schemaPath = "";
    node.schema = null;
    node.sourceHash = "";

    function computeHash() {
      return sha1([node.dialectName, node.xmlPathsRaw].join("|"));
    }

    function ensureSchema() {
      try {
        const xmlPaths = node.xmlPathsRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(p => path.resolve(p));
        if (!xmlPaths.length) throw new Error("No XML paths configured.");

        const hash = computeHash();
        const outPath = path.join(node.cacheDir, `${node.dialectName}.${hash}.schema.json`);

        let needBuild = true;
        if (fs.existsSync(outPath)) {
          // rebuild if any XML newer than schema file
          const schemaMtime = fs.statSync(outPath).mtimeMs;
          const newestXml = anyMtime(xmlPaths);
          needBuild = newestXml > schemaMtime;
        }

        if (needBuild) {
          node.status({ fill: "yellow", shape: "ring", text: "building schema..." });
          const schema = parseDialects(xmlPaths);
          fs.writeFileSync(outPath, JSON.stringify(schema, null, 2), "utf8");
          node.schema = schema;
          node.schemaPath = outPath;
          node.sourceHash = hash;
          node.status({ fill: "green", shape: "dot", text: "schema ready" });
        } else {
          node.schema = loadSchemaFile(outPath);
          node.schemaPath = outPath;
          node.sourceHash = hash;
          node.status({ fill: "green", shape: "dot", text: "schema cached" });
        }
      } catch (e) {
        node.status({ fill: "red", shape: "dot", text: e.message });
        node.error(e);
      }
    }

    node.on("close", function(done) { done(); });

    // Kick it off on deploy
    ensureSchema();

    // Expose getters to other nodes
    node.getSchema = () => node.schema;
    node.getEnums = () => node.schema?.enums || {};
    node.getMessages = () => node.schema?.messages || {};
    node.getSchemaPath = () => node.schemaPath;
    node.rebuild = () => { node.status({}); ensureSchema(); };
  }

  RED.nodes.registerType("mavlink-schema", MavlinkSchemaNode);

  // Admin endpoints for editor
  RED.httpAdmin.get("/mavlink-schema/enums", (req, res) => {
    try {
      const id = req.query.configId;
      const cfg = RED.nodes.getNode(id);
      if (!cfg) return res.status(404).json({ ok:false, error: "schema config not found" });
      res.json({ ok: true, enums: Object.keys(cfg.getEnums()).sort() });
    } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
  });

  RED.httpAdmin.get("/mavlink-schema/enum-members", (req, res) => {
    try {
      const id = req.query.configId, enumName = req.query.enumName;
      const cfg = RED.nodes.getNode(id);
      if (!cfg) return res.status(404).json({ ok:false, error: "schema config not found" });
      const members = cfg.getEnums()[enumName] || [];
      res.json({ ok: true, members });
    } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
  });

  RED.httpAdmin.get("/mavlink-schema/messages", (req, res) => {
    try {
      const id = req.query.configId;
      const cfg = RED.nodes.getNode(id);
      if (!cfg) return res.status(404).json({ ok:false, error: "schema config not found" });
      const msgs = cfg.getMessages();
      res.json({ ok: true, messages: Object.keys(msgs).sort().map(n => ({ name:n, id: msgs[n].id })) });
    } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
  });

  RED.httpAdmin.post("/mavlink-schema/rebuild", (req, res) => {
    try {
      const id = req.body.configId;
      const cfg = RED.nodes.getNode(id);
      if (!cfg) return res.status(404).json({ ok:false, error: "schema config not found" });
      cfg.rebuild();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
  });
};

