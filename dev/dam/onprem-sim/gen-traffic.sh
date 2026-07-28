#!/usr/bin/env bash
# Generate sample database activity so it shows up in TooVix DAM.
# Run INSIDE the VM after setup-onprem.sh. Connects as the app user over TCP so DAM sees a
# realistic principal + client IP. A mix of benign reads, broad PII/PCI reads, and writes.
set -euo pipefail

run() {
  mysql -h 127.0.0.1 -uappuser -papp_secret appdb -e "$1" >/dev/null 2>&1 \
    && echo "  ran: $1"
}

echo "Generating activity against the on-prem database (appdb)..."
run "SELECT id, full_name, city FROM customers WHERE city='Mumbai';"
run "SELECT full_name, email, phone FROM customers WHERE id=1;"
run "SELECT * FROM customers;"                                                  # broad PII read
run "SELECT c.full_name, k.card_number, k.cvv FROM customers c JOIN cards k ON k.customer_id=c.id;"  # PCI read
run "SELECT pan, aadhaar FROM customers;"                                       # sensitive columns
run "UPDATE orders SET status='paid' WHERE id=5;"
run "INSERT INTO orders (customer_id, amount, status) VALUES (2, 999.00, 'paid');"
run "DELETE FROM orders WHERE status='refunded';"
echo "Done. Open DAM -> Databases -> MYSQL-ONPREM-LAPTOP -> Database Activity."
