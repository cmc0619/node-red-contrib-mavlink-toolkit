# node-red-contrib-mavlink-toolkit

A modular MAVLink toolkit for Node‑RED:

- **mavlink-schema (config):** point at MAVLink dialect XML(s). Builds a cached `schema.json` (enums + messages + crc extras).
- **mavlink-io:** UDP or Serial transport of raw MAVLink frames. Output&nbsp;1 carries <code>HEARTBEAT</code> (msgid&nbsp;0); output&nbsp;2 carries all others.
- **mavlink-parse:** parses MAVLink v2 frames into structured objects using the schema.
- **mavlink-enum:** dropdown selector for enum values from the schema.
- **mavlink-build:** builds MAVLink v2 frames from message name + payload object.

## Install
1. Copy this folder to `~/.node-red/node-red-contrib-mavlink-toolkit/`
2. `cd ~/.node-red/node-red-contrib-mavlink-toolkit && npm install`
3. Restart Node‑RED

To enable Serial in `mavlink-io`, also:

