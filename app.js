const express = require('express');
const { Gateway, Wallets } = require('fabric-network');
const path = require('path');
const fs = require('fs');
const { create } = require('ipfs-http-client');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;


const ipfs = create(process.env.IPFS_URL || 'http://127.0.0.1:5001');

app.use(cors());
app.use(express.json());


async function getContract() {
    const ccpPath = path.resolve(
        __dirname,
        process.env.CCP_PATH || path.join('..', 'fabric-samples', 'test-network', 'organizations', 'peerOrganizations', 'org1.example.com', 'connection-org1.json')
    );
    const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));

    const walletPath = path.join(__dirname, process.env.WALLET_PATH || 'wallet');
    const wallet = await Wallets.newFileSystemWallet(walletPath);

    const identity = await wallet.get(process.env.FABRIC_IDENTITY || 'appUser');
    if (!identity) throw new Error(`Identity "${process.env.FABRIC_IDENTITY || 'appUser'}" not found. Run registerUser.js first.`);

    const gateway = new Gateway();
    await gateway.connect(ccp, {
        wallet,
        identity: process.env.FABRIC_IDENTITY || 'appUser',
        discovery: { enabled: true, asLocalhost: true }
    });

    const network = await gateway.getNetwork(process.env.CHANNEL_NAME || 'crimechannel');
    return { contract: network.getContract(process.env.CHAINCODE_NAME || 'basic'), gateway };
}


app.post('/api/evidence', async (req, res) => {
    const { evidenceId, caseId, description, officerName } = req.body;

    if (!evidenceId || !caseId || !description || !officerName) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields: evidenceId, caseId, description, officerName'
        });
    }

    const timestamp = new Date().toISOString();

    try {
        const metadata = JSON.stringify({
            evidenceId,
            caseId,
            description,
            officerName,
            timestamp
        });

        const added = await ipfs.add(metadata);
        const cid = added.path;

        const { contract, gateway } = await getContract();

        await contract.submitTransaction(
            'CreateAsset',
            evidenceId,   // ID
            caseId,       // Color → used as caseId
            "1",          // Size  → unused placeholder
            cid,          // Owner → repurposed to store IPFS CID
            "0"           // AppraisedValue → unused placeholder
        );

        await gateway.disconnect();

        res.status(200).json({
            success: true,
            blockchainId: evidenceId,
            ipfsHash: cid,
            officer: officerName,
            timestamp
        });
    } catch (error) {
        console.error('Submission Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


/**
 * API: Get All Evidence with Search & Filter
 * GET /api/evidence?caseId=CASE_99&status=PROCESSING&officer=John&page=1&limit=10&startDate=2026-01-01&endDate=2026-12-31
 */
app.get('/api/evidence', async (req, res) => {
    try {
        const { caseId, status, officer, page = 1, limit = 10, startDate, endDate, search } = req.query;
        const { contract, gateway } = await getContract();
        const result = await contract.evaluateTransaction('GetAllAssets');
        const assets = JSON.parse(result.toString());
        await gateway.disconnect();

        const enriched = await Promise.all(assets.map(async (asset) => {
            const cid = asset.Owner;
            let content = { status: 'COLLECTED' };

            if (cid && cid.startsWith('Qm')) {
                try {
                    const chunks = [];
                    for await (const chunk of ipfs.cat(cid)) chunks.push(chunk);
                    content = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
                } catch {
                    // Continue with defaults if IPFS fetch fails
                }
            }

            return {
                id: asset.ID,
                case_id: asset.Color,
                cid_pointer: cid,
                ipfs_status: cid && cid.startsWith('Qm') ? "VERIFIED" : "NO_CID",
                forensic_report: content
            };
        }));

        // Apply filters
        let filtered = enriched;

        if (caseId) {
            filtered = filtered.filter(e => e.case_id === caseId);
        }

        if (status) {
            filtered = filtered.filter(e => e.forensic_report.status === status);
        }

        if (officer) {
            filtered = filtered.filter(e => 
                e.forensic_report.officerName && 
                e.forensic_report.officerName.toLowerCase().includes(officer.toLowerCase())
            );
        }

        if (startDate) {
            const start = new Date(startDate);
            filtered = filtered.filter(e => new Date(e.forensic_report.timestamp) >= start);
        }

        if (endDate) {
            const end = new Date(endDate);
            filtered = filtered.filter(e => new Date(e.forensic_report.timestamp) <= end);
        }

        if (search) {
            const searchLower = search.toLowerCase();
            filtered = filtered.filter(e => 
                e.id.toLowerCase().includes(searchLower) ||
                e.case_id.toLowerCase().includes(searchLower) ||
                (e.forensic_report.description && e.forensic_report.description.toLowerCase().includes(searchLower))
            );
        }

        // Pagination
        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
        const startIdx = (pageNum - 1) * limitNum;
        const endIdx = startIdx + limitNum;
        const paginated = filtered.slice(startIdx, endIdx);

        res.status(200).json({
            total: filtered.length,
            page: pageNum,
            limit: limitNum,
            results: paginated
        });

    } catch (error) {
        console.error('List Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * API: Retrieve & Verify Evidence
 * GET /api/evidence/:id  (supports both evidenceId AND IPFS CID)
 */
app.get('/api/evidence/:id', async (req, res) => {
    try {
        const { contract, gateway } = await getContract();
        const param = req.params.id;

        let ledgerData = null;

        // Check if the param looks like an IPFS CID (starts with 'Qm')
        if (param.startsWith('Qm')) {
            // Scan all assets to find the one whose Owner (CID) matches
            const result = await contract.evaluateTransaction('GetAllAssets');
            const assets = JSON.parse(result.toString());

            const matched = assets.find(asset => asset.Owner === param);

            if (!matched) {
                await gateway.disconnect();
                return res.status(404).json({ error: `No evidence found with IPFS hash "${param}"` });
            }

            ledgerData = matched;
        } else {
            // Original behavior: lookup by evidenceId
            const result = await contract.evaluateTransaction('ReadAsset', param);
            ledgerData = JSON.parse(result.toString());
        }

        await gateway.disconnect();

        // Extract CID from Owner field
        const cid = ledgerData.Owner;

        if (!cid || !cid.startsWith('Qm')) {
            return res.status(200).json({
                status: "UNVERIFIED",
                blockchain: ledgerData,
                note: "No valid IPFS CID found on the ledger. This asset may have been created before the CID link was implemented."
            });
        }

        // Fetch original metadata from IPFS using the CID
        const chunks = [];
        for await (const chunk of ipfs.cat(cid)) {
            chunks.push(chunk);
        }
        const ipfsContent = new TextDecoder().decode(Buffer.concat(chunks));
        const forensicReport = JSON.parse(ipfsContent);

        // Return unified, verified report
        res.status(200).json({
            verification: "VERIFIED_BY_BLOCKCHAIN",
            ledger_info: {
                id: ledgerData.ID,
                case_id: ledgerData.Color,
                cid_pointer: cid
            },
            forensic_report: forensicReport
        });

    } catch (error) {
        console.error('Search Error:', error);
        res.status(404).json({ error: `"${req.params.id}" not found on Ledger` });
    }
});

/**
 * API: Update Evidence Metadata
 * PUT /api/evidence/:id
 */
app.put('/api/evidence/:id', async (req, res) => {
    try {
        const { caseId, description, status } = req.body;
        const { contract, gateway } = await getContract();

        // Get existing asset and metadata
        const result = await contract.evaluateTransaction('ReadAsset', req.params.id);
        const ledgerData = JSON.parse(result.toString());
        const cid = ledgerData.Owner;

        // Fetch current metadata from IPFS
        let currentMetadata = {};
        if (cid && cid.startsWith('Qm')) {
            try {
                const chunks = [];
                for await (const chunk of ipfs.cat(cid)) chunks.push(chunk);
                currentMetadata = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
            } catch (err) {
                console.warn('Could not fetch existing metadata:', err.message);
            }
        }

        // Merge with new updates
        const updatedMetadata = {
            ...currentMetadata,
            ...(caseId && { caseId }),
            ...(description && { description }),
            ...(status && { status }),
            lastModified: new Date().toISOString()
        };

        // Upload updated metadata to IPFS
        const metadataStr = JSON.stringify(updatedMetadata);
        const added = await ipfs.add(metadataStr);
        const newCid = added.path;

        // Update on blockchain with new CID
        await contract.submitTransaction(
            'UpdateAsset',
            req.params.id,
            caseId || ledgerData.Color,
            "1",
            newCid,
            "0"
        );

        await gateway.disconnect();

        res.status(200).json({
            success: true,
            evidenceId: req.params.id,
            updatedMetadata,
            newIpfsHash: newCid,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Update Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * API: Update Evidence Status
 * POST /api/evidence/:id/status
 */
app.post('/api/evidence/:id/status', async (req, res) => {
    try {
        const { newStatus, officerName, notes } = req.body;
        const validStatuses = ['COLLECTED', 'PROCESSING', 'ANALYZED', 'ARCHIVED', 'RELEASED'];

        if (!newStatus || !validStatuses.includes(newStatus)) {
            return res.status(400).json({
                success: false,
                error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        const { contract, gateway } = await getContract();

        // Get existing metadata
        const result = await contract.evaluateTransaction('ReadAsset', req.params.id);
        const ledgerData = JSON.parse(result.toString());
        const cid = ledgerData.Owner;

        let currentMetadata = { status: 'COLLECTED', custodyChain: [] };
        if (cid && cid.startsWith('Qm')) {
            try {
                const chunks = [];
                for await (const chunk of ipfs.cat(cid)) chunks.push(chunk);
                currentMetadata = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
            } catch (err) {
                console.warn('Could not fetch existing metadata:', err.message);
            }
        }

        // Add status change to custody chain
        if (!currentMetadata.custodyChain) {
            currentMetadata.custodyChain = [];
        }

        currentMetadata.custodyChain.push({
            timestamp: new Date().toISOString(),
            status: newStatus,
            officer: officerName || 'Unknown',
            notes: notes || ''
        });

        currentMetadata.status = newStatus;
        currentMetadata.lastStatusUpdate = new Date().toISOString();

        // Upload to IPFS
        const metadataStr = JSON.stringify(currentMetadata);
        const added = await ipfs.add(metadataStr);
        const newCid = added.path;

        await contract.submitTransaction(
            'UpdateAsset',
            req.params.id,
            ledgerData.Color,
            "1",
            newCid,
            "0"
        );

        await gateway.disconnect();

        res.status(200).json({
            success: true,
            evidenceId: req.params.id,
            previousStatus: currentMetadata.status,
            newStatus,
            officer: officerName,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Status Update Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * API: Get Chain of Custody for Evidence
 * GET /api/evidence/:id/chain-of-custody
 */
app.get('/api/evidence/:id/chain-of-custody', async (req, res) => {
    try {
        const { contract, gateway } = await getContract();

        const result = await contract.evaluateTransaction('ReadAsset', req.params.id);
        const ledgerData = JSON.parse(result.toString());
        const cid = ledgerData.Owner;

        if (!cid || !cid.startsWith('Qm')) {
            await gateway.disconnect();
            return res.status(404).json({ error: 'No custody data found' });
        }

        const chunks = [];
        for await (const chunk of ipfs.cat(cid)) {
            chunks.push(chunk);
        }

        const metadata = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
        await gateway.disconnect();

        res.status(200).json({
            evidenceId: req.params.id,
            currentStatus: metadata.status || 'COLLECTED',
            custodyChain: metadata.custodyChain || [],
            totalTransfers: (metadata.custodyChain || []).length
        });

    } catch (error) {
        console.error('Chain of Custody Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * API: Add Chain of Custody Entry
 * POST /api/evidence/:id/chain-of-custody
 */
app.post('/api/evidence/:id/chain-of-custody', async (req, res) => {
    try {
        const { fromOfficer, toOfficer, notes } = req.body;

        if (!fromOfficer || !toOfficer) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: fromOfficer, toOfficer'
            });
        }

        const { contract, gateway } = await getContract();

        const result = await contract.evaluateTransaction('ReadAsset', req.params.id);
        const ledgerData = JSON.parse(result.toString());
        const cid = ledgerData.Owner;

        let metadata = { custodyChain: [], status: 'COLLECTED' };
        if (cid && cid.startsWith('Qm')) {
            try {
                const chunks = [];
                for await (const chunk of ipfs.cat(cid)) chunks.push(chunk);
                metadata = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
            } catch (err) {
                console.warn('Could not fetch existing metadata:', err.message);
            }
        }

        if (!metadata.custodyChain) {
            metadata.custodyChain = [];
        }

        metadata.custodyChain.push({
            timestamp: new Date().toISOString(),
            from: fromOfficer,
            to: toOfficer,
            notes: notes || ''
        });

        // Upload to IPFS
        const metadataStr = JSON.stringify(metadata);
        const added = await ipfs.add(metadataStr);
        const newCid = added.path;

        await contract.submitTransaction(
            'UpdateAsset',
            req.params.id,
            ledgerData.Color,
            "1",
            newCid,
            "0"
        );

        await gateway.disconnect();

        res.status(200).json({
            success: true,
            evidenceId: req.params.id,
            transfer: { fromOfficer, toOfficer, timestamp: new Date().toISOString() },
            totalTransfers: metadata.custodyChain.length
        });

    } catch (error) {
        console.error('Chain of Custody Add Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * API: Bulk Create Evidence
 * POST /api/evidence/bulk
 */
app.post('/api/evidence/bulk', async (req, res) => {
    try {
        const { evidenceList } = req.body;

        if (!Array.isArray(evidenceList) || evidenceList.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'evidenceList must be a non-empty array'
            });
        }

        const results = [];
        const errors = [];

        for (let i = 0; i < evidenceList.length; i++) {
            const evidence = evidenceList[i];
            const { evidenceId, caseId, description, officerName } = evidence;

            if (!evidenceId || !caseId || !description || !officerName) {
                errors.push({
                    index: i,
                    evidence: evidenceId || `item_${i}`,
                    error: 'Missing required fields: evidenceId, caseId, description, officerName'
                });
                continue;
            }

            try {
                const timestamp = new Date().toISOString();
                const metadata = JSON.stringify({
                    evidenceId,
                    caseId,
                    description,
                    officerName,
                    timestamp,
                    status: 'COLLECTED'
                });

                const added = await ipfs.add(metadata);
                const cid = added.path;

                const { contract, gateway } = await getContract();

                await contract.submitTransaction(
                    'CreateAsset',
                    evidenceId,
                    caseId,
                    "1",
                    cid,
                    "0"
                );

                await gateway.disconnect();

                results.push({
                    index: i,
                    evidenceId,
                    ipfsHash: cid,
                    status: 'SUCCESS'
                });

            } catch (error) {
                errors.push({
                    index: i,
                    evidenceId: evidence.evidenceId,
                    error: error.message
                });
            }
        }

        res.status(200).json({
            success: errors.length === 0,
            totalSubmitted: evidenceList.length,
            successful: results.length,
            failed: errors.length,
            results,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (error) {
        console.error('Bulk Create Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * API: Bulk Delete Evidence
 * DELETE /api/evidence/bulk
 */
app.delete('/api/evidence/bulk', async (req, res) => {
    try {
        const { evidenceIds } = req.body;

        if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'evidenceIds must be a non-empty array'
            });
        }

        const results = [];
        const errors = [];

        for (const evidenceId of evidenceIds) {
            try {
                const { contract, gateway } = await getContract();

                const result = await contract.evaluateTransaction('ReadAsset', evidenceId);
                const ledgerData = JSON.parse(result.toString());
                const cid = ledgerData.Owner;

                await contract.submitTransaction('DeleteAsset', evidenceId);
                await gateway.disconnect();

                // Unpin from IPFS if valid CID exists
                let ipfsUnpinned = null;
                if (cid && cid.startsWith('Qm')) {
                    try {
                        await ipfs.pin.rm(cid);
                        ipfsUnpinned = cid;
                    } catch (ipfsErr) {
                        console.warn('IPFS unpin warning:', ipfsErr.message);
                    }
                }

                results.push({
                    evidenceId,
                    status: 'DELETED',
                    ipfsUnpinned
                });

            } catch (error) {
                errors.push({
                    evidenceId,
                    error: error.message
                });
            }
        }

        res.status(200).json({
            success: errors.length === 0,
            totalRequested: evidenceIds.length,
            successful: results.length,
            failed: errors.length,
            results,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (error) {
        console.error('Bulk Delete Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
app.delete('/api/evidence/:id', async (req, res) => {
    try {
        const { contract, gateway } = await getContract();

        // Fetch asset first to get CID for IPFS cleanup
        const result = await contract.evaluateTransaction('ReadAsset', req.params.id);
        const ledgerData = JSON.parse(result.toString());
        const cid = ledgerData.Owner;

        // Delete from blockchain
        await contract.submitTransaction('DeleteAsset', req.params.id);
        await gateway.disconnect();

        // Unpin from IPFS if a valid CID exists
        let ipfsUnpinned = null;
        if (cid && cid.startsWith('Qm')) {
            try {
                await ipfs.pin.rm(cid);
                await ipfs.repo.gc();
                ipfsUnpinned = cid;
            } catch (ipfsErr) {
                console.warn('IPFS unpin warning:', ipfsErr.message);
            }
        }

        res.status(200).json({
            success: true,
            deleted: req.params.id,
            ipfs_unpinned: ipfsUnpinned
        });

    } catch (error) {
        console.error('Delete Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(port, () => console.log(`🚀 Forensic API running on http://localhost:${port}`));