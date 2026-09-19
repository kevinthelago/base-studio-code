//! `bsc jobs` — job applications, starting from the one thing every application is built out of: what is
//! TRUE about the user.
//!
//! Slice 1 of `epic-job-applications`. The **experience bank** is the single source a tailored resume or
//! cover letter may draw on — roles, projects, results, skills, stories — and the **profile** is the
//! contact header every document carries. Postings, applications and rendered documents are later slices.
//!
//! ## Two rules the store enforces rather than trusts
//!
//! - **Every entry says where it came from.** A [`Source`] is `manual` (the user typed it) or points at
//!   what it was read out of — a resume file, a transcribed handwritten note, a `bsc memory` entry. A
//!   generated claim cites an entry, and the entry cites its origin, so any sentence in a document can be
//!   walked back to something the user actually wrote.
//! - **Confirmed means the user saw THIS text.** A new entry is a [`Status::Draft`]; only
//!   [`Status::Confirmed`] entries are usable ([`Entry::usable`]). Editing the content of a confirmed
//!   entry returns it to draft, because the confirmation was of the old words. That is what makes an
//!   agent-run import or a handwriting transcription safe: nothing it wrote reaches a document until the
//!   user has read it.

pub mod cli;
mod parse_period;
mod parse_source;
mod store;
mod valid_id;

pub use parse_period::parse_period;
pub use parse_source::parse_source;
pub use store::{EntryPatch, Jobs, ProfilePatch};
pub use valid_id::valid_id;

use serde::{Deserialize, Serialize};

/// What kind of fact an entry is. A resume skeleton places each kind in its own section.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// A role held: title at an organisation, over a period.
    Experience,
    /// A piece of work with its own name — at a job, or on the user's own time.
    Project,
    /// Something that happened because of the user — ideally with a number. Belongs to an experience or
    /// project through `parent`.
    Result,
    Skill,
    /// A longer account — how a problem was handled — which a cover letter draws on and a resume does not.
    Story,
    Education,
    Certification,
}

impl Kind {
    pub const ALL: [Kind; 7] =
        [Kind::Experience, Kind::Project, Kind::Result, Kind::Skill, Kind::Story, Kind::Education, Kind::Certification];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Experience => "experience",
            Kind::Project => "project",
            Kind::Result => "result",
            Kind::Skill => "skill",
            Kind::Story => "story",
            Kind::Education => "education",
            Kind::Certification => "certification",
        }
    }

    pub fn parse(s: &str) -> Result<Kind, String> {
        Kind::ALL.into_iter().find(|k| k.as_str() == s.trim()).ok_or_else(|| {
            let all: Vec<&str> = Kind::ALL.iter().map(|k| k.as_str()).collect();
            format!("`{s}` is not an entry kind — one of: {}", all.join(", "))
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Written, not yet read by the user. Never used in a document.
    Draft,
    /// The user has read this exact text and stands behind it.
    Confirmed,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Draft => "draft",
            Status::Confirmed => "confirmed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    /// Typed by the user.
    Manual,
    /// Read out of a resume file; the reference is its path.
    Resume,
    /// Transcribed from a handwritten note; the reference is the image or scan it came from.
    Note,
    /// Taken from a `bsc memory` entry; the reference is its id.
    Memory,
}

/// Where an entry came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub kind: SourceKind,
    /// What it was read out of. `None` only for `manual`.
    pub reference: Option<String>,
}

impl Source {
    pub fn manual() -> Source {
        Source { kind: SourceKind::Manual, reference: None }
    }
}

impl std::fmt::Display for Source {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = match self.kind {
            SourceKind::Manual => "manual",
            SourceKind::Resume => "resume",
            SourceKind::Note => "note",
            SourceKind::Memory => "memory",
        };
        match &self.reference {
            Some(r) => write!(f, "{kind}:{r}"),
            None => f.write_str(kind),
        }
    }
}

/// One fact in the bank.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// A stable slug — `[a-z0-9-]`, 1–60 chars — that a generated claim cites.
    pub id: String,
    pub kind: Kind,
    pub title: String,
    pub org: Option<String>,
    /// `YYYY` or `YYYY-MM`.
    pub start: Option<String>,
    /// `YYYY`, `YYYY-MM`, or `present`.
    pub end: Option<String>,
    pub body: Option<String>,
    pub tags: Vec<String>,
    /// The experience or project a result, story or skill belongs to.
    pub parent: Option<String>,
    pub status: Status,
    pub source: Source,
    pub created_ms: i64,
    pub updated_ms: i64,
}

impl Entry {
    /// Whether a document may draw on this entry. Drafts never may.
    pub fn usable(&self) -> bool {
        self.status == Status::Confirmed
    }
}

/// The contact header every document carries.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub name: Option<String>,
    /// A one-line professional headline, e.g. "Rust engineer · distributed systems".
    pub headline: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub location: Option<String>,
    /// Portfolio, GitHub, LinkedIn — in the order the user wants them shown.
    pub links: Vec<String>,
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
