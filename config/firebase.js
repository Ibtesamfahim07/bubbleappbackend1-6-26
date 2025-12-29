const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

let messaging = null;
let firebaseInitialized = false;

try {
  const serviceAccountPath = path.join(__dirname, '../firebase-service-account.json');
  
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = require(serviceAccountPath);
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    messaging = admin.messaging();
    firebaseInitialized = true;
    console.log('✅ Firebase initialized successfully');
  } else {
    console.warn('⚠️ firebase-service-account.json not found. Notifications will be saved to DB only.');
    console.warn('📝 To enable push notifications:');
    console.warn('   1. Create a Firebase project at https://console.firebase.google.com');
    console.warn('   2. Download the service account JSON');
    console.warn('   3. Save it as firebase-service-account.json in the Backend folder');
  }
} catch (error) {
  console.error('⚠️ Firebase initialization error:', error.message);
  console.warn('📝 Notifications will be saved to database only (no push notifications)');
}

module.exports = { 
  admin, 
  messaging,
  firebaseInitialized 
};