-- db-vm-a → orders (order management; low sensitivity, ship_address is mild PII)
USE orders;

CREATE TABLE IF NOT EXISTS products (
  id INT PRIMARY KEY AUTO_INCREMENT, sku VARCHAR(32), name VARCHAR(120),
  price DECIMAL(10,2), category VARCHAR(40)
);
CREATE TABLE IF NOT EXISTS orders (
  id INT PRIMARY KEY AUTO_INCREMENT, customer_ref INT, order_date DATE,
  total DECIMAL(10,2), ship_address VARCHAR(200), status VARCHAR(20)
);
CREATE TABLE IF NOT EXISTS order_items (
  id INT PRIMARY KEY AUTO_INCREMENT, order_id INT, product_id INT, qty INT, unit_price DECIMAL(10,2)
);

INSERT INTO products (sku,name,price,category)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<40)
SELECT CONCAT('SKU-',LPAD(n,5,'0')), CONCAT('Product ',n), ROUND(RAND()*500+5,2),
       ELT(1+FLOOR(RAND()*4),'Electronics','Home','Apparel','Grocery') FROM s;

INSERT INTO orders (customer_ref,order_date,total,ship_address,status)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<200)
SELECT 1+FLOOR(RAND()*200), DATE_SUB(CURDATE(), INTERVAL FLOOR(RAND()*365) DAY),
       ROUND(RAND()*1000+10,2), CONCAT(FLOOR(RAND()*999),' Main St, Metro City'),
       ELT(1+FLOOR(RAND()*4),'placed','shipped','delivered','cancelled') FROM s;

INSERT INTO order_items (order_id,product_id,qty,unit_price)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<400)
SELECT 1+FLOOR(RAND()*200), 1+FLOOR(RAND()*40), 1+FLOOR(RAND()*5), ROUND(RAND()*500+5,2) FROM s;
