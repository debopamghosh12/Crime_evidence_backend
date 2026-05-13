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


app.get('/api/evidence', async (req, res) => {
    try {
        const { contract, gateway } = await getContract();
        const result = await contract.evaluateTransaction('GetAllAssets');
        const assets = JSON.parse(result.toString());
        await gateway.disconnect();

        const enriched = await Promise.all(assets.map(async (asset) => {
            const cid = asset.Owner;

            if (!cid || !cid.startsWith('Qm')) {
                return {
                    id: asset.ID,
                    case_id: asset.Color,
                    cid_pointer: null,
                    ipfs_status: "NO_CID",
                    forensic_report: null
                };
            }

            try {
                const chunks = [];
                for await (const chunk of ipfs.cat(cid)) chunks.push(chunk);
                const content = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
                return {
                    id: asset.ID,
                    case_id: asset.Color,
                    cid_pointer: cid,
                    ipfs_status: "VERIFIED",
                    forensic_report: content
                };
            } catch {
                return {
                    id: asset.ID,
                    case_id: asset.Color,
                    cid_pointer: cid,
                    ipfs_status: "IPFS_FETCH_FAILED",
                    forensic_report: null
                };
            }
        }));

        res.status(200).json({
            total: enriched.length,
            evidence: enriched
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
 * API: Delete Evidence (Blockchain + IPFS unpin)
 * DELETE /api/evidence/:id
 */
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