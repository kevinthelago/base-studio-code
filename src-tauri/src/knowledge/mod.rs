//! Document store reads + the LLM-provider doc chat (#1300). The KB page and its
//! listing/write backend were removed (#1460 / #1504); `docstore` is now just the
//! base-dir + read-document surface, and `chat` is the doc-chat command.

pub mod docstore;
pub mod chat;
