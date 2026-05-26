/**
 * Firebase configuration — fill in your project values.
 *
 * Setup steps:
 *  1. Go to https://console.firebase.google.com — create a project
 *  2. Build → Authentication → Sign-in method → enable Google
 *  3. Build → Firestore Database → Create database (production mode)
 *  4. Firestore → Rules → paste the rules below and publish:
 *
 *     rules_version = '2';
 *     service cloud.firestore {
 *       match /databases/{database}/documents {
 *         match /users/{userId} {
 *           allow read, write: if request.auth != null && request.auth.uid == userId;
 *         }
 *       }
 *     }
 *
 *  5. Project Settings → General → Your apps → Web app → copy firebaseConfig
 *  6. Replace the placeholder values below with your project's values
 *
 * Note: Firebase API keys for client-side web apps are designed to be public.
 * Security is enforced by Firestore security rules, not the key itself.
 */
var FIREBASE_CONFIG = {
  apiKey:            'AIzaSyDC6yvvGJO4_VNv8P9dkjz0nhM4t7of2KA',
  authDomain:        'rank-624.firebaseapp.com',
  projectId:         'rank-624',
  storageBucket:     'rank-624.firebasestorage.app',
  messagingSenderId: '665358122591',
  appId:             '1:665358122591:web:6e2d526fbb27ffcc32e5ea',
};
