// Seed for the MongoDB-on-VM test database (`profiles`).
// Mirrors dev/client/mongo/init.js so the DAM agent's sensitive-collection tagging
// (users / kyc_documents / profiles → pii) has real data to classify.

db = db.getSiblingDB('profiles');

db.createCollection('users');
db.users.insertMany([
  {
    full_name: "Oliver Williams",
    email: "oliver.w@example.co.uk",
    phone: "+44-20-7946-0958",
    ni_number: "AB 12 34 56 C",
    postcode: "SW1A 1AA",
    date_of_birth: new Date("1985-03-14"),
    address: "10 Downing Street, London",
    country: "UK",
    preferences: { newsletter: true, sms: false },
    created_at: new Date()
  },
  {
    full_name: "Emma Thompson",
    email: "emma.t@corp.co.uk",
    phone: "+44-20-7946-1234",
    ni_number: "CD 56 78 90 D",
    postcode: "EC2R 8AH",
    date_of_birth: new Date("1992-11-28"),
    address: "1 Bank Street, London",
    country: "UK",
    preferences: { newsletter: true, sms: true },
    created_at: new Date()
  },
  {
    full_name: "Arjun Reddy",
    email: "arjun.r@example.in",
    phone: "+91-98765-43210",
    aadhaar: "4321 8765 2109",
    pan_number: "ABCDE1234F",
    date_of_birth: new Date("1988-06-15"),
    address: "Plot 42, Jubilee Hills, Hyderabad",
    country: "IN",
    preferences: { newsletter: false, sms: true },
    created_at: new Date()
  },
  {
    full_name: "Priya Nair",
    email: "priya.n@example.in",
    phone: "+91-91234-56780",
    aadhaar: "9988 7766 5544",
    pan_number: "PQRSX9876L",
    date_of_birth: new Date("1995-01-09"),
    address: "22 MG Road, Bengaluru",
    country: "IN",
    preferences: { newsletter: true, sms: false },
    created_at: new Date()
  },
  {
    full_name: "Daniel Osei",
    email: "d.osei@example.com",
    phone: "+1-415-555-0142",
    ssn: "412-55-8890",
    date_of_birth: new Date("1979-09-02"),
    address: "500 Market St, San Francisco, CA",
    country: "US",
    preferences: { newsletter: false, sms: false },
    created_at: new Date()
  }
]);

db.createCollection('kyc_documents');
db.kyc_documents.insertMany([
  {
    user_email: "oliver.w@example.co.uk",
    doc_type: "passport",
    doc_number: "533012345",
    issuing_country: "UK",
    status: "verified",
    verified_at: new Date("2025-02-11"),
    reviewer: "kyc-bot"
  },
  {
    user_email: "emma.t@corp.co.uk",
    doc_type: "driving_licence",
    doc_number: "THOMP912285EM9AB",
    issuing_country: "UK",
    status: "verified",
    verified_at: new Date("2025-03-04"),
    reviewer: "a.patel"
  },
  {
    user_email: "arjun.r@example.in",
    doc_type: "aadhaar",
    doc_number: "4321 8765 2109",
    issuing_country: "IN",
    status: "pending",
    verified_at: null,
    reviewer: null
  },
  {
    user_email: "priya.n@example.in",
    doc_type: "pan",
    doc_number: "PQRSX9876L",
    issuing_country: "IN",
    status: "verified",
    verified_at: new Date("2025-05-19"),
    reviewer: "kyc-bot"
  },
  {
    user_email: "d.osei@example.com",
    doc_type: "ssn_card",
    doc_number: "412-55-8890",
    issuing_country: "US",
    status: "rejected",
    verified_at: new Date("2025-06-22"),
    reviewer: "m.chen"
  }
]);

// Non-sensitive collection — useful as a control when checking DAM's PII tagging.
db.createCollection('login_events');
db.login_events.insertMany([
  { user_email: "oliver.w@example.co.uk", ip: "10.50.0.14", success: true, at: new Date("2026-07-01T08:12:00Z") },
  { user_email: "emma.t@corp.co.uk", ip: "10.50.0.19", success: true, at: new Date("2026-07-01T09:03:00Z") },
  { user_email: "arjun.r@example.in", ip: "10.50.0.23", success: false, at: new Date("2026-07-02T14:41:00Z") },
  { user_email: "arjun.r@example.in", ip: "10.50.0.23", success: true, at: new Date("2026-07-02T14:42:00Z") },
  { user_email: "d.osei@example.com", ip: "10.50.0.31", success: true, at: new Date("2026-07-03T17:55:00Z") }
]);

db.users.createIndex({ email: 1 }, { unique: true });
db.kyc_documents.createIndex({ user_email: 1 });
db.login_events.createIndex({ at: -1 });

print("seed: users=" + db.users.countDocuments() +
      " kyc_documents=" + db.kyc_documents.countDocuments() +
      " login_events=" + db.login_events.countDocuments());
