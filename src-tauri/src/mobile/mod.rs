//! The paired mobile companion (#1300): the relay `tunnel` (wire protocol + Noise crypto +
//! dial-out transport) and FCM (`fcm`) push delivery.

pub mod fcm;
pub mod tunnel;
