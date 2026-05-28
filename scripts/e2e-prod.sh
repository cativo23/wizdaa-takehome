#!/usr/bin/env bash
set -uo pipefail

BASE_URL="https://ooo.cativo.dev"
PASSED=0
FAILED=0
TIMEOUT=15

pass() { echo "PASS | $1"; PASSED=$((PASSED + 1)); }
fail() { echo "FAIL | $1 | $2"; FAILED=$((FAILED + 1)); }

# Scenario 1: Health check
HTTP=$(curl --max-time $TIMEOUT -s -o /dev/null -w "%{http_code}" "$BASE_URL/")
if [[ "$HTTP" == "200" ]]; then pass "GET / health"; else fail "GET / health" "got $HTTP expected 200"; fi

# Scenario 2: Balance read with auth (employee)
RESP=$(curl --max-time $TIMEOUT -s -w "\n%{http_code}" -H "X-Employee-Id: emp1" -H "X-Role: employee" "$BASE_URL/balances?employeeId=emp1&locationId=loc1")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)
if [[ "$HTTP" == "200" && "$BODY" =~ "available" ]]; then pass "GET /balances with auth"; else fail "GET /balances with auth" "got $HTTP body lacks 'available'"; fi

# Scenario 3: Balance read without auth headers
HTTP=$(curl --max-time $TIMEOUT -s -o /dev/null -w "%{http_code}" "$BASE_URL/balances?employeeId=emp1&locationId=loc1")
if [[ "$HTTP" == "400" ]]; then pass "GET /balances without auth rejects"; else fail "GET /balances without auth" "got $HTTP expected 400"; fi

# Scenario 4: IDOR - employee can't read other employee's balance
HTTP=$(curl --max-time $TIMEOUT -s -o /dev/null -w "%{http_code}" -H "X-Employee-Id: emp1" -H "X-Role: employee" "$BASE_URL/balances?employeeId=emp999&locationId=loc1")
if [[ "$HTTP" == "403" ]]; then pass "IDOR protection on balance"; else fail "IDOR protection" "got $HTTP expected 403"; fi

# Scenario 5: Submit with missing fields
KEY=$(uuidgen)
HTTP=$(curl --max-time $TIMEOUT -s -o /dev/null -w "%{http_code}" -X POST -H "X-Employee-Id: emp1" -H "X-Role: employee" -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" -d '{"employeeId":"emp1"}' "$BASE_URL/time-off-requests")
if [[ "$HTTP" == "400" ]]; then pass "Submit validation: missing fields"; else fail "Submit validation: missing fields" "got $HTTP expected 400"; fi

# Scenario 6: Submit without Idempotency-Key
HTTP=$(curl --max-time $TIMEOUT -s -o /dev/null -w "%{http_code}" -X POST -H "X-Employee-Id: emp1" -H "X-Role: employee" -H "Content-Type: application/json" -d '{"employeeId":"emp1","locationId":"loc1","startDate":"2026-07-01","endDate":"2026-07-03"}' "$BASE_URL/time-off-requests")
if [[ "$HTTP" == "400" ]]; then pass "Submit validation: missing Idempotency-Key"; else fail "Submit validation: missing Idempotency-Key" "got $HTTP expected 400"; fi

# Scenario 7: Submit with past date
PAST_DATE="2025-01-01"
KEY=$(uuidgen)
HTTP=$(curl --max-time $TIMEOUT -s -o /dev/null -w "%{http_code}" -X POST -H "X-Employee-Id: emp1" -H "X-Role: employee" -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" -d "{\"employeeId\":\"emp1\",\"locationId\":\"loc1\",\"startDate\":\"$PAST_DATE\",\"endDate\":\"$PAST_DATE\"}" "$BASE_URL/time-off-requests")
if [[ "$HTTP" == "400" ]]; then pass "Submit validation: past date"; else fail "Submit validation: past date" "got $HTTP expected 400"; fi

# Scenario 8: Submit with invalid date (Feb 30)
KEY=$(uuidgen)
HTTP=$(curl --max-time $TIMEOUT -s -o /dev/null -w "%{http_code}" -X POST -H "X-Employee-Id: emp1" -H "X-Role: employee" -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" -d '{"employeeId":"emp1","locationId":"loc1","startDate":"2026-02-30","endDate":"2026-02-30"}' "$BASE_URL/time-off-requests")
if [[ "$HTTP" == "400" ]]; then pass "Submit validation: invalid date"; else fail "Submit validation: invalid date" "got $HTTP expected 400"; fi

# Scenario 9: Submit with date range > 365 days
KEY=$(uuidgen)
HTTP=$(curl --max-time $TIMEOUT -s -o /dev/null -w "%{http_code}" -X POST -H "X-Employee-Id: emp1" -H "X-Role: employee" -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" -d '{"employeeId":"emp1","locationId":"loc1","startDate":"2026-06-01","endDate":"2028-06-01"}' "$BASE_URL/time-off-requests")
if [[ "$HTTP" == "400" ]]; then pass "Submit validation: range > 365 days"; else fail "Submit validation: range > 365 days" "got $HTTP expected 400"; fi

# Scenario 10: Submit with ISO timestamp instead of date
KEY=$(uuidgen)
HTTP=$(curl --max-time $TIMEOUT -s -o /dev/null -w "%{http_code}" -X POST -H "X-Employee-Id: emp1" -H "X-Role: employee" -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" -d '{"employeeId":"emp1","locationId":"loc1","startDate":"2026-07-01T10:00:00Z","endDate":"2026-07-03T10:00:00Z"}' "$BASE_URL/time-off-requests")
if [[ "$HTTP" == "400" ]]; then pass "Submit validation: ISO timestamp rejected"; else fail "Submit validation: ISO timestamp" "got $HTTP expected 400"; fi

# Scenario 11: Submit without auth
KEY=$(uuidgen)
HTTP=$(curl --max-time $TIMEOUT -s -o /dev/null -w "%{http_code}" -X POST -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" -d '{"employeeId":"emp1","locationId":"loc1","startDate":"2026-07-01","endDate":"2026-07-03"}' "$BASE_URL/time-off-requests")
if [[ "$HTTP" == "400" ]]; then pass "Submit without auth rejects"; else fail "Submit without auth" "got $HTTP expected 400"; fi

# Scenario 12: IDOR - employee can't submit for another employeeId
KEY=$(uuidgen)
HTTP=$(curl --max-time $TIMEOUT -s -o /dev/null -w "%{http_code}" -X POST -H "X-Employee-Id: emp1" -H "X-Role: employee" -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" -d '{"employeeId":"emp999","locationId":"loc1","startDate":"2026-07-01","endDate":"2026-07-03"}' "$BASE_URL/time-off-requests")
if [[ "$HTTP" == "403" ]]; then pass "IDOR protection on submit"; else fail "IDOR protection on submit" "got $HTTP expected 403"; fi

# Scenario 13: Well-formed submit (expect 201 or 409 insufficient balance - both valid)
KEY=$(uuidgen)
RESP=$(curl --max-time $TIMEOUT -s -w "\n%{http_code}" -X POST -H "X-Employee-Id: emp1" -H "X-Role: employee" -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" -d '{"employeeId":"emp1","locationId":"loc1","startDate":"2026-07-01","endDate":"2026-07-03"}' "$BASE_URL/time-off-requests")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)
if [[ "$HTTP" == "201" ]]; then
  if [[ "$BODY" =~ "id" ]]; then pass "Submit well-formed: accepted"; else fail "Submit well-formed" "201 but no id in body"; fi
elif [[ "$HTTP" == "409" ]]; then
  pass "Submit well-formed: insufficient balance (expected with unseeded HCM)"
else
  fail "Submit well-formed" "got $HTTP expected 201 or 409"
fi

# Scenario 14: Idempotency - duplicate key returns same result
EMP_ID="empTest$(date +%s)"
KEY=$(uuidgen)
RESP1=$(curl --max-time $TIMEOUT -s -w "\n%{http_code}" -X POST -H "X-Employee-Id: $EMP_ID" -H "X-Role: employee" -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" -d "{\"employeeId\":\"$EMP_ID\",\"locationId\":\"loc1\",\"startDate\":\"2026-10-10\",\"endDate\":\"2026-10-10\"}" "$BASE_URL/time-off-requests" || echo -e "\n000")
HTTP1=$(echo "$RESP1" | tail -1)
if [[ "$HTTP1" == "000" || "$HTTP1" == "" ]]; then
  fail "Idempotency" "first request failed/timeout"
else
  sleep 1
  RESP2=$(curl --max-time $TIMEOUT -s -w "\n%{http_code}" -X POST -H "X-Employee-Id: $EMP_ID" -H "X-Role: employee" -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" -d "{\"employeeId\":\"$EMP_ID\",\"locationId\":\"loc1\",\"startDate\":\"2026-10-10\",\"endDate\":\"2026-10-10\"}" "$BASE_URL/time-off-requests" || echo -e "\n000")
  HTTP2=$(echo "$RESP2" | tail -1)
  if [[ "$HTTP1" == "$HTTP2" ]]; then 
    pass "Idempotency: duplicate key same result ($HTTP1)"
  else 
    fail "Idempotency" "first $HTTP1, second $HTTP2"
  fi
fi

# Scenario 15: TLS certificate is valid (Let's Encrypt)
CERT_OUT=$(curl --max-time $TIMEOUT -vI "$BASE_URL/" 2>&1)
if echo "$CERT_OUT" | grep -qi "issuer.*Let's Encrypt"; then
  pass "TLS: Let's Encrypt cert"
else
  fail "TLS cert" "expected Let's Encrypt issuer"
fi

echo ""
echo "=========================================="
echo "Total: $((PASSED + FAILED)) | Passed: $PASSED | Failed: $FAILED"
echo "=========================================="
exit $([[ $FAILED -eq 0 ]] && echo 0 || echo 1)
