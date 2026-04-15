/**
 * FAHIM DZ — Firebase Admin SDK Configuration
 */

const admin = require('firebase-admin');

let db;
let firebaseReady = false;

function initFirebase() {
  if (admin.apps.length > 0) {
    db = admin.firestore();
    firebaseReady = true;
    return db;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  // Check if real credentials are provided
  if (!projectId || projectId === 'YOUR_PROJECT_ID' ||
      !privateKey || privateKey.includes('YOUR_KEY') ||
      !clientEmail || clientEmail.includes('YOUR_CLIENT_EMAIL')) {
    console.warn('⚠️  Firebase not configured — running in DEMO mode');
    console.warn('   Add your Firebase credentials to .env to enable full functionality');
    firebaseReady = false;
    return null;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        privateKey: privateKey.replace(/\\n/g, '\n').replace(/\n/g, '\n'),
        clientEmail,
      }),
    });

    db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    firebaseReady = true;
    console.log('✅ Firebase Firestore connected');
    return db;
  } catch (err) {
    console.error('❌ Firebase init error:', err.message);
    console.warn('   Server will run in DEMO mode (no database persistence)');
    firebaseReady = false;
    return null;
  }
}

function getDb() {
  if (!firebaseReady) {
    throw new Error('Firebase not configured. Add your credentials to .env');
  }
  if (!db) initFirebase();
  return db;
}

function isFirebaseReady() {
  return firebaseReady;
}

module.exports = { initFirebase, getDb, isFirebaseReady, admin };
