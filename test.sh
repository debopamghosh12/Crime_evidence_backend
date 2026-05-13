#!/bin/bash

# ── Fabric Environment Setup ──────────────────────────────────────────────────
export PATH=$PATH:~/crime-evidence-mgmt/fabric-samples/bin
export FABRIC_CFG_PATH=~/crime-evidence-mgmt/fabric-samples/config/
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ROOTCERT_FILE=~/crime-evidence-mgmt/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
export CORE_PEER_MSPCONFIGPATH=~/crime-evidence-mgmt/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
export CORE_PEER_ADDRESS=localhost:7051
export ORDERER_CA=~/crime-evidence-mgmt/fabric-samples/test-network/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem
export PEER0_ORG1_CA=~/crime-evidence-mgmt/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
# ─────────────────────────────────────────────────────────────────────────────

echo "--- Step 1: POST evidence ---"
RESPONSE=$(curl -s -X POST http://localhost:3000/api/evidence \
  -H "Content-Type: application/json" \
  -d '{"evidenceId":"EVID_E2E","caseId":"CASE_E2E","description":"End to end test","officerName":"Officer_E2E"}')
echo $RESPONSE
CID=$(echo $RESPONSE | python3 -c "import sys,json; print(json.load(sys.stdin)['ipfsHash'])")
echo ""

echo "--- Step 2: Verify on Blockchain ---"
peer chaincode query -C crimechannel -n basic -c '{"function":"ReadAsset","Args":["EVID_E2E"]}'
echo ""

echo "--- Step 3: Fetch from IPFS directly ---"
ipfs cat $CID
echo ""

echo "--- Step 4: GET via API ---"
curl -s http://localhost:3000/api/evidence/EVID_E2E | python3 -m json.tool
echo ""

echo "--- Step 5: DELETE via API ---"
curl -s -X DELETE http://localhost:3000/api/evidence/EVID_E2E
echo ""

echo "--- Step 6: Confirm deleted ---"
curl -s http://localhost:3000/api/evidence/EVID_E2E
echo ""
echo "✅ All tests done!"