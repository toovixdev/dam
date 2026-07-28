import os, oracledb

# One-way TLS, no wallet (ADB has is_mtls_connection_required = false)
DSN = ("(description=(retry_count=3)(retry_delay=3)"
       "(address=(protocol=tcps)(port=1521)(host=adb.us-phoenix-1.oraclecloud.com))"
       "(connect_data=(service_name=g0ad108ae2ff232_toovixadb_low.adb.oraclecloud.com))"
       "(security=(ssl_server_dn_match=yes)))")

con = oracledb.connect(user="ADMIN", password=os.environ["ORA_PW"], dsn=DSN)
cur = con.cursor()
print("connected:", con.version)

# Test statements — each is audited verbatim (no SQL-Dev wrapper) and lands in DAM
cur.execute("SELECT count(1) FROM admin.customers")
print("count(1)        ->", cur.fetchone()[0])

cur.execute("SELECT email, card_number FROM admin.customers")          # pci+pii, real row_count
print("select rows     ->", len(cur.fetchall()))

cur.execute("INSERT INTO admin.customers (full_name, email) VALUES ('Py Test','py@example.com')")
cur.execute("UPDATE admin.customers SET phone='+00' WHERE email='py@example.com'")
cur.execute("DELETE FROM admin.customers WHERE email='py@example.com'")
con.commit()
print("insert/update/delete done")

cur.close(); con.close()

