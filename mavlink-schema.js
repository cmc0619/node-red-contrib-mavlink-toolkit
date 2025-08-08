module.exports = function(RED) {
  const fs = require("fs");
  const path = require("path");
  const { XMLParser } = require("fast-xml-parser");
  const mkdirp = require("mkdirp");
  const crypto = require("crypto");
  const AdmZip = require("adm-zip");
  const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

  function sha1(s) { return crypto.createHash("sha1").update(s).digest("hex"); }

  // --- download/extract helpers ---
  async function downloadRepoZip(repo, ref, destZipPath) {
    // refs/heads/<ref> path works for named branches; if you want tags, swap to refs/tags/<tag>
    const url = `https://codeload.github.com/${repo}/zip/refs/heads/${ref}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destZipPath, buf);
  }

  function extractZip(zipPath, destRoot, targetDir) {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(destRoot, true);
    // GitHub zips create a top-level folder like "<reponame>-<ref>/"
    const entries = zip.getEntries().map(e => e.entryName.split('/')[0]).filter(Boolean);
    const top = entries.length ? entries[0] : "";
    const topAbs = path.join(destRoot, top);
    if (targetDir && topAbs !== targetDir) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(topAbs, targetDir);
      return targetDir;
    }
    return topAbs;
  }

  // --- schema build from XML(s) ---
  function parseDialects(entryXmlPaths) {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", allowBooleanAttributes: true });
    const seen = new Set();
    const enumsMap = new Map(); // name -> [{key,value,comment,isBitmask}]
    const msgsMap  = new Map(); // name -> {id, crc, fields:[...]}

    function loadOne(absPath) {
      const abs = path.resolve(absPath);
      if (seen.has(abs)) return;
      seen.add(abs);
      const xml = fs.readFileSync(abs, "utf8");
      const doc = parser.parse(xml).mavlink;

      // includes
      const includes = []
        .concat(doc.include || [])
        .map(i => path.resolve(path.dirname(abs), i["@_file"]))
        .filter(Boolean);
      for (const inc of includes) loadOne(inc);

      // enums
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

      // messages
      const messages = doc.messages?.message ? [].concat(doc.messages.message) : [];
      for (const m of messages) {
        const name = m["@_name"];
        const id   = Number(m["@_id"]);
        const crc  = Number(m["@_crc"] ?? m["@_crc_extra"] ?? 0);
        const fields = (m.field ? [].concat(m.field) : []).map(f => {
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

  function loadSchemaFile(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  function newestMtime(paths) {
    return Math.max(...paths.map(p => fs.statSync(p).mtimeMs));
  }

  function MavlinkSchemaNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.dialectName = config.dialectName || "dialect";
    node.xmlPathsRaw = config.xmlPaths || "";
    node.cacheDir = config.cacheDir || path.join(RED.settings.userDir || ".", "mavlink-cache");

    node.autoDownload = !!config.autoDownload;
    node.repo = config.repo || "mavlink/mavlink";
    node.ref = config.ref || "master";
    node.subdir = config.subdir || "message_definitions/v1.0";

    node.schemaPath = "";
    node.schema = null;

    async function ensureSchema() {
      try {
        let xmlPaths = node.xmlPathsRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(p => path.resolve(p));

        if (node.autoDownload) {
          const baseCache = node.cacheDir;
          mkdirp.sync(baseCache);

          const sourceRoot = path.join(baseCache, "_sources");
          mkdirp.sync(sourceRoot);

          const sourceKey = `${node.repo.replace(/[\/:]/g,'_')}@${node.ref}`;
          const zipPath = path.join(sourceRoot, `${sourceKey}.zip`);
          const extractRoot = path.join(sourceRoot, sourceKey);

          let needFetch = true;
          if (fs.existsSync(zipPath) && fs.existsSync(extractRoot)) {
            const ageDays = (Date.now() - fs.statSync(zipPath).mtimeMs) / (1000*60*60*24);
            needFetch = ageDays > 7;
          }

          if (needFetch || !fs.existsSync(extractRoot)) {
            node.status({ fill:"yellow", shape:"ring", text:`downloading ${node.repo}@${node.ref}...` });
            await downloadRepoZip(node.repo, node.ref, zipPath);
            const extractedTop = extractZip(zipPath, sourceRoot, extractRoot);
            if (extractedTop !== extractRoot && !fs.existsSync(extractRoot)) {
              // ensure the expected path exists
              fs.renameSync(extractedTop, extractRoot);
            }
          }

          const dialectDir = path.join(extractRoot, node.subdir);
          const candidates = [
            path.join(dialectDir, "common.xml"),
            path.join(dialectDir, "ardupilotmega.xml")
          ].filter(p => fs.existsSync(p));

          if (!candidates.length) throw new Error(`No XMLs found under ${dialectDir}`);

          // Merge auto and manual paths; dedupe
          const set = new Set(xmlPaths.concat(candidates));
          xmlPaths = Array.from(set);
        }

        if (!xmlPaths.length) throw new Error("No XML paths configured (or auto-download failed).");

        // Build or reuse schema cache
        const hash = sha1([node.dialectName, xmlPaths.join("|")].join("|"));
        const outPath = path.join(node.cacheDir, `${node.dialectName}.${hash}.schema.json`);

        let needBuild = true;
        if (fs.existsSync(outPath)) {
          const schemaMtime = fs.statSync(outPath).mtimeMs;
          const newestXml = newestMtime(xmlPaths);
          needBuild = newestXml > schemaMtime;
        }

        if (needBuild) {
          node.status({ fill: "yellow", shape: "ring", text: "building schema..." });
          const schema = parseDialects(xmlPaths);
          fs.writeFileSync(outPath, JSON.stringify(schema, null, 2), "utf8");
          node.schema = schema;
          node.schemaPath = outPath;
          node.status({ fill: "green", shape: "dot", text: "schema ready" });
        } else {
          node.schema = loadSchemaFile(outPath);
          node.schemaPath = outPath;
          node.status({ fill: "green", shape: "dot", text: "schema cached" });
        }
      } catch (e) {
        node.status({ fill: "red", shape: "dot", text: e.message });
        node.error(e);
      }
    }

    // make helpers visible to other nodes
    node.getSchema = () => node.schema;
    node.getEnums = () => node.schema?.enums || {};
    node.getMessages = () => node.schema?.messages || {};
    node.getSchemaPath = () => node.schemaPath;
    node.rebuild = async () => { node.status({}); await ensureSchema(); };

    // build on deploy
    ensureSchema().catch(()=>{});

    node.on("close", (done) => done());
  }

  RED.nodes.registerType("mavlink-schema", MavlinkSchemaNode);

  // Admin endpoints
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

  RED.httpAdmin.post("/mavlink-schema/rebuild", async (req, res) => {
    try {
      const id = req.body.configId;
      const cfg = RED.nodes.getNode(id);
      if (!cfg) return res.status(404).json({ ok:false, error: "schema config not found" });
      await cfg.rebuild?.();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
  });
};

