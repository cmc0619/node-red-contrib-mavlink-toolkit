# node-red-contrib-mavlink-toolkit

A modular MAVLink toolkit for Node‑RED:

- **mavlink-schema (config):** point at MAVLink dialect XML(s). Builds a cached `schema.json` (enums + messages + crc extras).
- **mavlink-io:** UDP or Serial transport of raw MAVLink frames.
- **mavlink-parse:** parses MAVLink v2 frames into structured objects using the schema.
- **mavlink-enum:** dropdown selector for enum values from the schema.
- **mavlink-build:** builds MAVLink v2 frames from message name + payload object.

## Install
1. Copy this folder to `~/.node-red/node-red-contrib-mavlink-toolkit/`
2. `cd ~/.node-red/node-red-contrib-mavlink-toolkit && npm install`
3. Restart Node‑RED

To enable Serial in `mavlink-io`, also: npm install serialport


## Auto-download dialects
In the **MAVLink Schema** config, enable **Auto-download** to fetch XMLs directly from GitHub:

- **Repo:** `mavlink/mavlink`
- **Ref:** `master` (or a tag/branch)
- **Subdir:** `message_definitions/v1.0`

On first run (and on rebuild), the node downloads a zip to your cache, extracts it, and uses `common.xml` + `ardupilotmega.xml`. You can still specify local XML paths; they will be merged with the downloaded set.

## Example Flows

### Receive and parse over UDP
[MAVLink I/O (udp)] → [MAVLink Message Parser] → [Debug]

### Build and send COMMAND_LONG
[Inject {payload:{target_system:1, target_component:1, command:22, confirmation:0, param1:1, ...}}]
→ [MAVLink Build (COMMAND_LONG)]
→ [MAVLink I/O (udp)]

### Use enums in the flow
[Inject {payload:"MAV_FRAME_GLOBAL_RELATIVE_ALT"}]
→ [MAVLink Enum (enum=MAV_FRAME, source=msg.payload)]
→ [Function merges value into COMMAND_LONG payload]
→ [MAVLink Build] → [I/O]

## Notes & Limitations
- MAVLink v2 framing (0xFD), X.25 CRC + CRC extra.
- Field packing/unpacking supports size-sorted ordering (8,4,2,1), scalars, fixed arrays, and `char[n]` strings.
- Extensions and variable‑length arrays not yet implemented.

## License
MIT

