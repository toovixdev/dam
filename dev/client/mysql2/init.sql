-- Client MySQL #2 (port 3307): Inventory database — used to demo a SECOND JIT broker.

CREATE TABLE IF NOT EXISTS inventory.items (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  sku        VARCHAR(32),
  name       VARCHAR(120),
  qty        INT,
  unit_cost  DECIMAL(10,2)
);

INSERT INTO inventory.items (sku, name, qty, unit_cost) VALUES
  ('SKU-001', 'Widget A', 120, 4.50),
  ('SKU-002', 'Widget B',  40, 9.10),
  ('SKU-003', 'Gasket',   900, 0.30);

-- ── JIT broker account (least-privilege, NOT root) ──
-- Can create/drop users and grant ONLY read on inventory (with grant option).
CREATE USER IF NOT EXISTS 'dam_jit_inventory'@'%' IDENTIFIED BY 'broker-inventory-pw';
GRANT CREATE USER ON *.* TO 'dam_jit_inventory'@'%';
GRANT SELECT ON inventory.* TO 'dam_jit_inventory'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
