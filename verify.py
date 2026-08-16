import json
import asyncio
from fastapi.testclient import TestClient
from main import app

client = TestClient(app, raise_server_exceptions=False)

endpoints_to_test = [
    "/stock/FPT",
    "/hold/VNM",
    "/news/FPT",
    "/financial-summary/FPT",
    "/score/VNM",
    "/market",
    "/fund-favorites",
    "/growth-stocks",
    "/dividend-kings",
    "/analyze/FPT"
]

print("=== STARTING VERIFICATION ===\n")
for endpoint in endpoints_to_test:
    response = client.get(endpoint)
    print(f"GET {endpoint}")
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2, ensure_ascii=False)}")
    print("-" * 50)
print("\n=== VERIFICATION COMPLETE ===")
