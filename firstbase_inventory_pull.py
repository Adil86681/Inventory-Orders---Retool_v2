"""
Firstbase Inventory Data Pull
==============================
Authenticates with Okta (client credentials) and pulls all inventory
data from the Firstbase GraphQL API, saving results to a CSV file.

Requirements:
    pip install requests

Usage:
    python firstbase_inventory_pull.py

Output:
    firstbase_inventory.csv  (written to the same directory)
"""

import requests
import csv
import json
import sys
import time
from datetime import datetime

# ── Credentials ───────────────────────────────────────────────────────────────
CLIENT_ID     = "0oau04j3bsve6vpjw5d7"
CLIENT_SECRET = "MiwE0mSx9MiCDT5sc9NRCfKM2svJ0dgGYQljA77dxd5CneM-JzfH_OKW6oP3fMGI"
TOKEN_URL     = "https://auth.firstbasehq.com/oauth2/v1/token"
GRAPHQL_URL   = "https://api.firstbasehq.com/graphql"
SCOPE         = "firstbase:m2m:read-only"

# ── Pagination ─────────────────────────────────────────────────────────────────
PAGE_SIZE     = 100   # items per page (increase to 500 if allowed)
OUTPUT_FILE   = "firstbase_inventory.csv"


# ── GraphQL query ──────────────────────────────────────────────────────────────
# Field names are based on the SQL schema extracted from the Retool app.
# If any field causes an error, see the "Adjusting fields" note at the bottom.
INVENTORY_QUERY = """
query GetInventory($pageNumber: Int!, $pageSize: Int!, $filters: InventoryFilter) {
  getAllInventories(
    pagingAndSorting: {
      pageNumber: $pageNumber
      pageSize: $pageSize
      sort: [{ field: "createdAt", direction: DESC }]
    }
    inventoryFilter: $filters
  ) {
    total
    data {
      id
      createdAt
      updatedAt
      deployStatus
      deployReason
      conditionStatus
      serialNumber
      renewalDate
      firstbaseSupplied
      orderItemId
      returnOrderItemId
      description
      sku {
        id
        productTitle
        genericCategory
      }
      vendor {
        id
        name
      }
      organization {
        id
        name
      }
      person {
        id
        forename
        surname
      }
      warehouse {
        id
        name
      }
      office {
        id
        name
      }
      region {
        name
      }
    }
  }
}
"""

# Simpler fallback query with fewer nested fields (try if the above fails)
INVENTORY_QUERY_SIMPLE = """
query GetInventory($pageNumber: Int!, $pageSize: Int!, $filters: InventoryFilter) {
  getAllInventories(
    pagingAndSorting: {
      pageNumber: $pageNumber
      pageSize: $pageSize
    }
    inventoryFilter: $filters
  ) {
    total
    data {
      id
      createdAt
      updatedAt
      deployStatus
      deployReason
      conditionStatus
      serialNumber
      firstbaseSupplied
      orderItemId
      returnOrderItemId
      description
    }
  }
}
"""


def get_access_token() -> str:
    """Exchange client credentials for a bearer token — tries multiple approaches."""
    print("🔑  Requesting access token...")

    attempts = [
        # 1. Basic auth + no scope (most permissive — Okta assigns scope automatically)
        dict(data={"grant_type": "client_credentials"},
             auth=(CLIENT_ID, CLIENT_SECRET)),
        # 2. Basic auth + explicit scope (matches the original curl example)
        dict(data={"grant_type": "client_credentials", "scope": SCOPE},
             auth=(CLIENT_ID, CLIENT_SECRET)),
        # 3. Body params + scope (some Okta setups prefer this)
        dict(data={"grant_type": "client_credentials", "scope": SCOPE,
                   "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET}),
    ]

    for i, kwargs in enumerate(attempts, 1):
        print(f"    Attempt {i}/3...")
        resp = requests.post(
            TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=30,
            **kwargs,
        )
        body = resp.json()
        if resp.status_code == 200 and body.get("access_token"):
            print(f"✅  Token acquired (attempt {i}).")
            return body["access_token"]
        print(f"    ↳ {resp.status_code}: {body.get('error')} — {body.get('error_description','')}")

    print("\n❌  All token attempts failed.")
    print("\n── Troubleshooting ──────────────────────────────────────────────")
    print("  The Okta policy is rejecting this client. Possible causes:")
    print("  1. IP restriction — this client may only work from Firstbase servers.")
    print("     Ask your Firstbase admin if the M2M client has an IP allowlist.")
    print("  2. Grant type not enabled — ask admin to enable 'client_credentials'")
    print("     for client ID:", CLIENT_ID)
    print("  3. Wrong auth server — try changing TOKEN_URL to:")
    print("     https://auth.firstbasehq.com/oauth2/v1/token")
    print("─────────────────────────────────────────────────────────────────")
    sys.exit(1)


def run_query(token: str, query: str, variables: dict) -> dict:
    """Execute a GraphQL query and return the parsed response."""
    resp = requests.post(
        GRAPHQL_URL,
        json={"query": query, "variables": variables},
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type":  "application/json",
        },
        timeout=60,
    )
    if resp.status_code != 200:
        print(f"❌  GraphQL request failed ({resp.status_code}): {resp.text[:500]}")
        sys.exit(1)

    body = resp.json()
    if "errors" in body:
        print(f"❌  GraphQL errors: {json.dumps(body['errors'], indent=2)}")
        # Return body anyway so caller can inspect partial data
        return body

    return body


def flatten_row(item: dict) -> dict:
    """Flatten nested GraphQL object into a flat dict matching the 25 SQL columns."""
    sku       = item.get("sku")       or {}
    vendor    = item.get("vendor")    or {}
    org       = item.get("organization") or {}
    person    = item.get("person")    or {}
    warehouse = item.get("warehouse") or {}
    office    = item.get("office")    or {}
    region    = item.get("region")    or {}

    # Build "assigned_to" the same way the SQL does: warehouse > office > person
    if warehouse.get("name"):
        assigned_to = warehouse["name"]
    elif office.get("name"):
        assigned_to = office["name"]
    elif person.get("forename") or person.get("surname"):
        assigned_to = f"{person.get('forename','')} {person.get('surname','')}".strip()
    else:
        assigned_to = ""

    return {
        "inventory_id":           item.get("id"),
        "created_date":           item.get("createdAt"),
        "updated_at":             item.get("updatedAt"),
        "product_title":          sku.get("productTitle"),
        "deploy_status":          item.get("deployStatus"),
        "deploy_reason":          item.get("deployReason"),
        "condition_status":       item.get("conditionStatus"),
        "serial_number":          item.get("serialNumber"),
        "renewal_date":           item.get("renewalDate"),
        "organization_name":      org.get("name"),
        "vendor_name":            vendor.get("name"),
        "assigned_to":            assigned_to,
        "firstbase_supplied":     item.get("firstbaseSupplied"),
        "billing_type":           item.get("billingType"),       # may not be exposed
        "order_item_id":          item.get("orderItemId"),
        "return_order_item_id":   item.get("returnOrderItemId"),
        "organization_id":        org.get("id"),
        "sku_id":                 sku.get("id"),
        "warehouse_id":           warehouse.get("id"),
        "warehouse_name":         warehouse.get("name"),
        "person_id":              person.get("id"),
        "office_id":              office.get("id"),
        "description":            item.get("description"),
        "generic_category":       sku.get("genericCategory"),
        "region":                 region.get("name"),
    }


FIELDNAMES = [
    "inventory_id", "created_date", "updated_at", "product_title",
    "deploy_status", "deploy_reason", "condition_status", "serial_number",
    "renewal_date", "organization_name", "vendor_name", "assigned_to",
    "firstbase_supplied", "billing_type", "order_item_id", "return_order_item_id",
    "organization_id", "sku_id", "warehouse_id", "warehouse_name",
    "person_id", "office_id", "description", "generic_category", "region",
]


def pull_all_inventory(token: str, query: str):
    """Paginate through all inventory and write to CSV."""
    print(f"\n📦  Starting inventory pull → {OUTPUT_FILE}")
    print(f"    Page size : {PAGE_SIZE}")

    page       = 1
    total      = None
    written    = 0
    start_time = time.time()

    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES, extrasaction="ignore")
        writer.writeheader()

        while True:
            variables = {
                "pageNumber": page,
                "pageSize":   PAGE_SIZE,
                "filters":    None,
            }

            body = run_query(token, query, variables)

            # Handle GraphQL errors on first page
            if "errors" in body and page == 1:
                print("\n⚠️   Full query failed — retrying with simplified query...")
                body = run_query(token, INVENTORY_QUERY_SIMPLE, variables)
                if "errors" in body:
                    print(f"❌  Simplified query also failed: {body['errors']}")
                    sys.exit(1)
                query = INVENTORY_QUERY_SIMPLE   # use simple query for remaining pages

            result = body.get("data", {}).get("getAllInventories", {})
            items  = result.get("data") or []

            if total is None:
                total = result.get("total", "?")
                print(f"    Total items: {total:,}" if isinstance(total, int) else f"    Total items: {total}")

            if not items:
                break

            rows = [flatten_row(item) for item in items]
            writer.writerows(rows)
            written += len(rows)

            elapsed = time.time() - start_time
            pct     = f"{written/total*100:.1f}%" if isinstance(total, int) and total else ""
            print(f"    Page {page:4d}  |  {written:>8,} rows written  {pct}  ({elapsed:.1f}s)")

            if len(items) < PAGE_SIZE:
                break   # last page

            page += 1
            time.sleep(0.1)   # be gentle — 100ms between pages

    elapsed = time.time() - start_time
    print(f"\n✅  Done!  {written:,} rows written to {OUTPUT_FILE}  ({elapsed:.1f}s total)")


def main():
    print("=" * 60)
    print("  Firstbase Inventory Pull")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    token = get_access_token()
    pull_all_inventory(token, INVENTORY_QUERY)


if __name__ == "__main__":
    main()


# ──────────────────────────────────────────────────────────────────────────────
# ADJUSTING FIELDS
# ──────────────────────────────────────────────────────────────────────────────
# If you get a GraphQL "field does not exist" error, the script will automatically
# fall back to a simpler query. You can also run an introspection query to see
# exactly what fields are available:
#
#   import requests, json
#   token = "<your_token>"
#   r = requests.post(
#       "https://api.firstbasehq.com/graphql",
#       json={"query": "{ __type(name: \"Inventory\") { fields { name } } }"},
#       headers={"Authorization": f"Bearer {token}"}
#   )
#   print(json.dumps(r.json(), indent=2))
