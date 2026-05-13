# Forensic Evidence Management - Backend

**Overview**

This backend provides a simple forensic evidence management API that stores evidence metadata on IPFS and references it on a Hyperledger Fabric ledger. It includes endpoints to create, read, update, delete, search, bulk-operate, and manage chain-of-custody for evidence.

**Features**

- **Create Evidence:** Store evidence metadata on IPFS and register an asset on Fabric.
- **Search & Filter:** Query evidence with `caseId`, `status`, `officer`, date ranges, full-text `search`, and pagination.
- **Update Metadata:** Update case ID, description, and status; pushes new metadata to IPFS and updates ledger pointer.
- **Status Tracking:** Record status updates (COLLECTED → PROCESSING → ANALYZED → ARCHIVED → RELEASED).
- **Chain of Custody:** Record and retrieve custody transfers with timestamps and officer names.
- **Bulk Operations:** Bulk create and bulk delete endpoints for batch workflows.
- **IPFS Integration:** Metadata stored on IPFS; ledger stores the CID pointer.

**Prerequisites**

- Node.js installed
- Hyperledger Fabric test network running and accessible (channel `crimechannel` by default)
- Wallet with identity (run `registerUser.js` / `enrollAdmin.js` as required)
- IPFS daemon running (default `http://127.0.0.1:5001`)

**Environment Variables (optional)**

- `PORT` — HTTP server port (default `3000`)
- `IPFS_URL` — IPFS API URL (default `http://127.0.0.1:5001`)
- `CCP_PATH` — Path to Fabric connection profile
- `WALLET_PATH` — Wallet folder path (default `wallet`)
- `FABRIC_IDENTITY` — Wallet identity to use (default `appUser`)
- `CHANNEL_NAME` — Fabric channel (default `crimechannel`)
- `CHAINCODE_NAME` — Chaincode name (default `basic`)

**Run**

Start the server:

```bash
node app.js
```

Server will run on `http://localhost:3000` by default.

**Postman Collection**

Import `postman_collection.json` in this folder to get ready-made requests for all endpoints.

File: [postman_collection.json](postman_collection.json)


**API Endpoints & Test Data (for Postman)**

- **Create Evidence**
  - Method: `POST`
  - URL: `/api/evidence`
  - Headers: `Content-Type: application/json`
  - Body:

```json
{
  "evidenceId": "EVID_2026_001",
  "caseId": "CASE_99",
  "description": "Digital camera found at crime scene",
  "officerName": "Officer John Smith"
}
```

- **Bulk Create Evidence**
  - Method: `POST`
  - URL: `/api/evidence/bulk`
  - Body:

```json
{
  "evidenceList": [
    {
      "evidenceId": "EVID_2026_002",
      "caseId": "CASE_99",
      "description": "Photo of scene",
      "officerName": "Officer Jane"
    },
    {
      "evidenceId": "EVID_2026_003",
      "caseId": "CASE_99",
      "description": "USB drive",
      "officerName": "Officer Jane"
    }
  ]
}
```

- **Get All Evidence (search & filter)**
  - Method: `GET`
  - URL: `/api/evidence`
  - Query parameters examples: `?caseId=CASE_99&page=1&limit=10&status=PROCESSING&officer=Jane&startDate=2026-01-01&endDate=2026-12-31&search=camera`

- **Get Evidence by ID or IPFS CID**
  - Method: `GET`
  - URL: `/api/evidence/:id` (e.g. `/api/evidence/EVID_2026_001` or `/api/evidence/Qm...`)

- **Update Evidence Metadata**
  - Method: `PUT`
  - URL: `/api/evidence/:id`
  - Body (any subset):

```json
{
  "caseId": "CASE_100",
  "description": "Updated description",
  "status": "PROCESSING"
}
```

- **Update Evidence Status**
  - Method: `POST`
  - URL: `/api/evidence/:id/status`
  - Body:

```json
{
  "newStatus": "ANALYZED",
  "officerName": "Officer Smith",
  "notes": "DNA analysis complete"
}
```

- **Get Chain of Custody**
  - Method: `GET`
  - URL: `/api/evidence/:id/chain-of-custody`

- **Add Chain of Custody Entry**
  - Method: `POST`
  - URL: `/api/evidence/:id/chain-of-custody`
  - Body:

```json
{
  "fromOfficer": "Officer Smith",
  "toOfficer": "Officer Jones",
  "notes": "Transferred to lab"
}
```

- **Bulk Delete Evidence**
  - Method: `DELETE`
  - URL: `/api/evidence/bulk`
  - Body:

```json
{
  "evidenceIds": ["EVID_2026_002", "EVID_2026_003"]
}
```

- **Delete Evidence by ID**
  - Method: `DELETE`
  - URL: `/api/evidence/:id`

**Data Schema (metadata stored on IPFS)**

Example metadata object stored on IPFS for an evidence item:

```json
{
  "evidenceId": "EVID_2026_001",
  "caseId": "CASE_99",
  "description": "Digital camera found at crime scene",
  "officerName": "Officer John Smith",
  "timestamp": "2026-05-13T12:34:56.789Z",
  "status": "COLLECTED",
  "custodyChain": [
    {
      "timestamp": "2026-05-13T12:34:56.789Z",
      "from": "Officer A",
      "to": "Officer B",
      "notes": "Transferred"
    }
  ]
}
```

Fields of interest:
- `evidenceId` (string) — unique ID used as ledger asset ID
- `caseId` (string) — case identifier mapped to ledger asset Color
- `description` (string) — free-text description
- `officerName` (string) — creator/last modifier
- `timestamp` (ISO string) — creation timestamp
- `status` (string) — state from the allowed set
- `custodyChain` (array) — transfer history entries

**Notes & Troubleshooting**

- If you see identity errors, ensure the wallet contains `appUser` or set `FABRIC_IDENTITY` to a valid identity.
- If IPFS fetch fails, the API returns `ipfs_status: "IPFS_FETCH_FAILED"` for that item but still returns ledger info.
- The implementation updates ledger entries by re-submitting `CreateAsset` with the same ID and new CID. Ensure chaincode accepts overwriting via `CreateAsset` or extend chaincode accordingly.

If you want, I can:
- Run a quick smoke test (curl) from this workspace to confirm endpoints respond.
- Add Postman environment with `baseUrl` and example environment file.
- Harden the chaincode interactions to use `UpdateAsset` instead of reusing `CreateAsset` (requires chaincode change).

---

File: [postman_collection.json](postman_collection.json)
