// Client MongoDB: Profiles database (simulates MONGO-PROFILES-UK)

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
    aadhaar: null,
    pan_number: null,
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
    aadhaar: null,
    pan_number: null,
    preferences: { newsletter: true, sms: true },
    created_at: new Date()
  },
  {
    full_name: "Arjun Reddy",
    email: "arjun.r@example.in",
    phone: "+91-98765-43210",
    ni_number: null,
    postcode: null,
    date_of_birth: new Date("1988-06-15"),
    address: "42 MG Road, Hyderabad 500001",
    aadhaar: "234567890123",
    pan_number: "ABCDE1234F",
    preferences: { newsletter: false, sms: true },
    created_at: new Date()
  },
  {
    full_name: "Meera Sharma",
    email: "meera.s@mail.in",
    phone: "+91-87654-32109",
    ni_number: null,
    postcode: null,
    date_of_birth: new Date("1995-07-19"),
    address: "15 Connaught Place, Delhi 110001",
    aadhaar: "345678901234",
    pan_number: "FGHIJ5678K",
    preferences: { newsletter: true, sms: true },
    created_at: new Date()
  },
  {
    full_name: "James O'Brien",
    email: "james.ob@example.ie",
    phone: "+353-1-234-5678",
    ni_number: null,
    postcode: "D02 X285",
    date_of_birth: new Date("1990-01-22"),
    address: "5 Grafton Street, Dublin",
    aadhaar: null,
    pan_number: null,
    preferences: { newsletter: false, sms: false },
    created_at: new Date()
  }
]);

db.createCollection('kyc_documents');

db.kyc_documents.insertMany([
  { user_email: "arjun.r@example.in",  doc_type: "aadhaar",  status: "verified",  verified_at: new Date(), photo_url: "/kyc/arjun_aadhaar.jpg" },
  { user_email: "meera.s@mail.in",     doc_type: "pan",      status: "verified",  verified_at: new Date(), photo_url: "/kyc/meera_pan.jpg" },
  { user_email: "oliver.w@example.co.uk", doc_type: "passport", status: "verified", verified_at: new Date(), photo_url: "/kyc/oliver_passport.jpg" }
]);

db.createCollection('activity_log');

db.activity_log.insertMany([
  { user_email: "oliver.w@example.co.uk", action: "profile_view",   ip: "82.132.1.10",  ts: new Date() },
  { user_email: "arjun.r@example.in",     action: "kyc_upload",     ip: "103.21.58.1",   ts: new Date() },
  { user_email: "emma.t@corp.co.uk",       action: "settings_update",ip: "82.132.2.20",   ts: new Date() }
]);
