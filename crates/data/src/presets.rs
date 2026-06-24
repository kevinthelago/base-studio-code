//! Vendor presets for the generic REST connector (#1197).
//!
//! The dedicated connectors cover the big systems; the **generic** [`RestConnector`] covers
//! anything else — but it needs to be told which resources to read. A **preset** is that
//! configuration shipped as *data*: a vendor id mapped to a default set of resources over its
//! JSON REST API, so smaller / regional systems (SoftExpert, Bitrix24, Freshsales, …) work
//! **out of the box** — the user supplies only the instance URL + token (captured in the fetch
//! closure), not the resource list.
//!
//! A preset is a *starting* mapping: endpoints and response envelopes vary by edition/version,
//! so callers can override the resources. A popular preset is a candidate to be promoted to a
//! dedicated connector later (e.g. to capture its behavior layer), exactly as the spec's
//! connector seam intends. Read-only throughout (#782).

use serde_json::Value;

use crate::rest::{RestConnector, RestResource};
use crate::Result;

/// One resource entry: `(object name, request path/segment, array_key envelope)`.
/// `array_key` is the key the record array lives under in the response, or `None` if the body
/// is itself an array.
type ResourceDef = (&'static str, &'static str, Option<&'static str>);

/// An out-of-the-box REST configuration for a vendor.
pub struct VendorPreset {
    pub id: &'static str,
    pub label: &'static str,
    /// Coarse grouping for the catalog UI (`crm`, `bpm-grc`, `support`, …).
    pub category: &'static str,
    resources: &'static [ResourceDef],
}

impl VendorPreset {
    /// This preset's resources as [`RestResource`]s.
    pub fn resources(&self) -> Vec<RestResource> {
        self.resources.iter().map(|(n, p, k)| RestResource::new(*n, *p, *k)).collect()
    }

    /// The resource object names this preset reads (for the catalog "contributes" blurb, #1288).
    pub fn resource_names(&self) -> Vec<&'static str> {
        self.resources.iter().map(|(n, _, _)| *n).collect()
    }

    /// Build a generic REST connector configured for this vendor. `fetch` resolves a resource
    /// path against the instance and carries the auth — never stored by the connector (#1194).
    pub fn connector(
        &self,
        instance_name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> RestConnector {
        RestConnector::new(instance_name, self.resources(), fetch)
    }
}

/// The packaged vendor catalog. Out-of-the-box support for smaller systems without a dedicated
/// connector. Each is a default mapping over the vendor's REST API (adjustable per instance).
pub const CATALOG: &[VendorPreset] = &[
    // BPM / GRC / quality
    VendorPreset {
        id: "softexpert",
        label: "SoftExpert Suite",
        category: "bpm-grc",
        resources: &[
            ("workflow", "workflow", None),
            ("document", "document", None),
            ("form", "form", None),
            ("problem", "problem", None),
            ("risk", "risk", None),
            ("audit", "audit", None),
        ],
    },
    // CRM
    VendorPreset {
        id: "bitrix24",
        label: "Bitrix24",
        category: "crm",
        resources: &[
            ("deals", "crm.deal.list", Some("result")),
            ("contacts", "crm.contact.list", Some("result")),
            ("companies", "crm.company.list", Some("result")),
        ],
    },
    VendorPreset {
        id: "freshsales",
        label: "Freshsales",
        category: "crm",
        resources: &[
            ("contacts", "contacts", Some("contacts")),
            ("accounts", "sales_accounts", Some("sales_accounts")),
            ("deals", "deals", Some("deals")),
        ],
    },
    VendorPreset {
        id: "sugarcrm",
        label: "SugarCRM",
        category: "crm",
        resources: &[
            ("accounts", "Accounts", Some("records")),
            ("contacts", "Contacts", Some("records")),
            ("opportunities", "Opportunities", Some("records")),
        ],
    },
    VendorPreset {
        id: "insightly",
        label: "Insightly",
        category: "crm",
        resources: &[
            ("contacts", "Contacts", None),
            ("organisations", "Organisations", None),
            ("opportunities", "Opportunities", None),
        ],
    },
    VendorPreset {
        id: "copper",
        label: "Copper",
        category: "crm",
        resources: &[
            ("people", "people/search", None),
            ("companies", "companies/search", None),
            ("opportunities", "opportunities/search", None),
        ],
    },
    VendorPreset {
        id: "close",
        label: "Close",
        category: "crm",
        resources: &[("leads", "lead", Some("data")), ("contacts", "contact", Some("data"))],
    },
    VendorPreset {
        id: "capsule",
        label: "Capsule CRM",
        category: "crm",
        resources: &[
            ("parties", "parties", Some("parties")),
            ("opportunities", "opportunities", Some("opportunities")),
        ],
    },
    VendorPreset {
        id: "vtiger",
        label: "Vtiger",
        category: "crm",
        resources: &[
            ("contacts", "Contacts", Some("result")),
            ("organizations", "Accounts", Some("result")),
            ("potentials", "Potentials", Some("result")),
        ],
    },
    VendorPreset {
        id: "suitecrm",
        label: "SuiteCRM",
        category: "crm",
        resources: &[
            ("accounts", "module/Accounts", Some("data")),
            ("contacts", "module/Contacts", Some("data")),
        ],
    },
    // Support
    VendorPreset {
        id: "freshdesk",
        label: "Freshdesk",
        category: "support",
        resources: &[("tickets", "tickets", None), ("contacts", "contacts", None)],
    },
    // BPM / GRC / process (the SoftExpert neighbourhood)
    VendorPreset {
        id: "bizagi",
        label: "Bizagi",
        category: "bpm-grc",
        resources: &[("cases", "cases", Some("data")), ("processes", "processes", Some("data"))],
    },
    VendorPreset {
        id: "appian",
        label: "Appian",
        category: "bpm-grc",
        resources: &[("records", "records", Some("data")), ("processes", "processes", Some("data"))],
    },
    VendorPreset {
        id: "camunda",
        label: "Camunda",
        category: "bpm-grc",
        resources: &[
            ("process-definitions", "process-definition", None),
            ("process-instances", "process-instance", None),
            ("tasks", "task", None),
        ],
    },
    VendorPreset {
        id: "processmaker",
        label: "ProcessMaker",
        category: "bpm-grc",
        resources: &[("cases", "cases", Some("data")), ("processes", "processes", Some("data"))],
    },
    VendorPreset {
        id: "pega",
        label: "Pega",
        category: "bpm-grc",
        resources: &[("cases", "cases", Some("data")), ("dataobjects", "data", Some("data"))],
    },
    // CRM
    VendorPreset {
        id: "keap",
        label: "Keap",
        category: "crm",
        resources: &[
            ("contacts", "contacts", Some("contacts")),
            ("companies", "companies", Some("companies")),
            ("opportunities", "opportunities", Some("opportunities")),
        ],
    },
    VendorPreset {
        id: "bullhorn",
        label: "Bullhorn",
        category: "crm",
        resources: &[
            ("candidates", "query/Candidate", Some("data")),
            ("joborders", "query/JobOrder", Some("data")),
            ("placements", "query/Placement", Some("data")),
        ],
    },
    VendorPreset {
        id: "creatio",
        label: "Creatio",
        category: "crm",
        resources: &[("contacts", "Contact", Some("value")), ("accounts", "Account", Some("value"))],
    },
    VendorPreset {
        id: "salesflare",
        label: "Salesflare",
        category: "crm",
        resources: &[
            ("contacts", "contacts", None),
            ("accounts", "accounts", None),
            ("opportunities", "opportunities", None),
        ],
    },
    // ERP / accounting
    VendorPreset {
        id: "dynamics-bc",
        label: "Dynamics 365 Business Central",
        category: "erp",
        resources: &[
            ("customers", "customers", Some("value")),
            ("items", "items", Some("value")),
            ("salesOrders", "salesOrders", Some("value")),
        ],
    },
    VendorPreset {
        id: "sap-b1",
        label: "SAP Business One",
        category: "erp",
        resources: &[
            ("businessPartners", "BusinessPartners", Some("value")),
            ("orders", "Orders", Some("value")),
            ("items", "Items", Some("value")),
        ],
    },
    VendorPreset {
        id: "acumatica",
        label: "Acumatica",
        category: "erp",
        resources: &[
            ("customers", "Customer", None),
            ("salesOrders", "SalesOrder", None),
            ("stockItems", "StockItem", None),
        ],
    },
    VendorPreset {
        id: "zoho-books",
        label: "Zoho Books",
        category: "accounting",
        resources: &[
            ("invoices", "invoices", Some("invoices")),
            ("contacts", "contacts", Some("contacts")),
            ("items", "items", Some("items")),
        ],
    },
    // HR / HRIS
    VendorPreset {
        id: "bamboohr",
        label: "BambooHR",
        category: "hr",
        resources: &[("employees", "employees/directory", Some("employees"))],
    },
    VendorPreset {
        id: "personio",
        label: "Personio",
        category: "hr",
        resources: &[("employees", "company/employees", Some("data"))],
    },
    VendorPreset {
        id: "gusto",
        label: "Gusto",
        category: "hr",
        resources: &[("employees", "employees", None), ("payrolls", "payrolls", None)],
    },
    VendorPreset {
        id: "workday",
        label: "Workday",
        category: "hr",
        resources: &[("workers", "workers", Some("data"))],
    },
    // Support / helpdesk
    VendorPreset {
        id: "intercom",
        label: "Intercom",
        category: "support",
        resources: &[
            ("contacts", "contacts", Some("data")),
            ("companies", "companies", Some("data")),
            ("conversations", "conversations", Some("conversations")),
        ],
    },
    VendorPreset {
        id: "front",
        label: "Front",
        category: "support",
        resources: &[
            ("conversations", "conversations", Some("_results")),
            ("contacts", "contacts", Some("_results")),
        ],
    },
    // Marketing
    VendorPreset {
        id: "mailchimp",
        label: "Mailchimp",
        category: "marketing",
        resources: &[("lists", "lists", Some("lists")), ("campaigns", "campaigns", Some("campaigns"))],
    },
    VendorPreset {
        id: "activecampaign",
        label: "ActiveCampaign",
        category: "marketing",
        resources: &[("contacts", "contacts", Some("contacts")), ("deals", "deals", Some("deals"))],
    },
    VendorPreset {
        id: "klaviyo",
        label: "Klaviyo",
        category: "marketing",
        resources: &[("profiles", "profiles", Some("data")), ("lists", "lists", Some("data"))],
    },
    // E-commerce
    VendorPreset {
        id: "shopify",
        label: "Shopify",
        category: "ecommerce",
        resources: &[
            ("products", "products", Some("products")),
            ("orders", "orders", Some("orders")),
            ("customers", "customers", Some("customers")),
        ],
    },
    VendorPreset {
        id: "bigcommerce",
        label: "BigCommerce",
        category: "ecommerce",
        resources: &[
            ("products", "catalog/products", Some("data")),
            ("orders", "orders", Some("data")),
            ("customers", "customers", Some("data")),
        ],
    },
    VendorPreset {
        id: "woocommerce",
        label: "WooCommerce",
        category: "ecommerce",
        resources: &[
            ("products", "products", None),
            ("orders", "orders", None),
            ("customers", "customers", None),
        ],
    },
    // Project / work management
    VendorPreset {
        id: "smartsheet",
        label: "Smartsheet",
        category: "work",
        resources: &[("sheets", "sheets", Some("data"))],
    },
    VendorPreset {
        id: "wrike",
        label: "Wrike",
        category: "work",
        resources: &[("tasks", "tasks", Some("data")), ("projects", "folders", Some("data"))],
    },
    VendorPreset {
        id: "clickup",
        label: "ClickUp",
        category: "work",
        resources: &[("tasks", "task", Some("tasks"))],
    },
    VendorPreset {
        id: "trello",
        label: "Trello",
        category: "work",
        resources: &[
            ("boards", "members/me/boards", None),
            ("cards", "members/me/cards", None),
        ],
    },
    VendorPreset {
        id: "notion",
        label: "Notion",
        category: "work",
        resources: &[("search", "search", Some("results"))],
    },
    // Billing / subscriptions
    VendorPreset {
        id: "chargebee",
        label: "Chargebee",
        category: "billing",
        resources: &[
            ("subscriptions", "subscriptions", Some("list")),
            ("customers", "customers", Some("list")),
        ],
    },
    VendorPreset {
        id: "recurly",
        label: "Recurly",
        category: "billing",
        resources: &[
            ("accounts", "accounts", Some("data")),
            ("subscriptions", "subscriptions", Some("data")),
        ],
    },
    // ── Discovered batch (gap sweep) ───────────────────────────────────────
    // More GRC / quality / BPM (the SoftExpert neighbourhood)
    VendorPreset {
        id: "nintex",
        label: "Nintex",
        category: "bpm-grc",
        resources: &[("workflows", "workflows", Some("value")), ("instances", "instances", Some("value"))],
    },
    VendorPreset {
        id: "flowable",
        label: "Flowable",
        category: "bpm-grc",
        resources: &[
            ("process-definitions", "repository/process-definitions", Some("data")),
            ("process-instances", "runtime/process-instances", Some("data")),
            ("tasks", "runtime/tasks", Some("data")),
        ],
    },
    VendorPreset {
        id: "bonita",
        label: "Bonita",
        category: "bpm-grc",
        resources: &[("cases", "bpm/case", None), ("processes", "bpm/process", None), ("tasks", "bpm/humanTask", None)],
    },
    VendorPreset {
        id: "auditboard",
        label: "AuditBoard",
        category: "bpm-grc",
        resources: &[("controls", "controls", Some("data")), ("risks", "risks", Some("data")), ("audits", "audits", Some("data"))],
    },
    VendorPreset {
        id: "onetrust",
        label: "OneTrust",
        category: "bpm-grc",
        resources: &[("assessments", "assessments", Some("content")), ("risks", "risks", Some("content"))],
    },
    VendorPreset {
        id: "vanta",
        label: "Vanta",
        category: "bpm-grc",
        resources: &[("tests", "tests", Some("results")), ("controls", "controls", Some("results"))],
    },
    VendorPreset {
        id: "drata",
        label: "Drata",
        category: "bpm-grc",
        resources: &[("controls", "controls", Some("data")), ("monitors", "monitors", Some("data"))],
    },
    VendorPreset {
        id: "qualio",
        label: "Qualio",
        category: "bpm-grc",
        resources: &[("documents", "documents", Some("data")), ("changes", "change-controls", Some("data"))],
    },
    // More ERP
    VendorPreset {
        id: "sap-s4hana",
        label: "SAP S/4HANA",
        category: "erp",
        resources: &[
            ("businessPartners", "API_BUSINESS_PARTNER/A_BusinessPartner", Some("value")),
            ("salesOrders", "API_SALES_ORDER_SRV/A_SalesOrder", Some("value")),
        ],
    },
    VendorPreset {
        id: "oracle-erp",
        label: "Oracle ERP Cloud",
        category: "erp",
        resources: &[
            ("suppliers", "suppliers", Some("items")),
            ("invoices", "invoices", Some("items")),
            ("customers", "receivablesCustomerProfiles", Some("items")),
        ],
    },
    VendorPreset {
        id: "dynamics-fo",
        label: "Dynamics 365 Finance & Operations",
        category: "erp",
        resources: &[
            ("customers", "data/Customers", Some("value")),
            ("vendors", "data/Vendors", Some("value")),
            ("salesOrders", "data/SalesOrderHeaders", Some("value")),
        ],
    },
    VendorPreset {
        id: "epicor",
        label: "Epicor Kinetic",
        category: "erp",
        resources: &[
            ("customers", "Erp.BO.CustomerSvc/Customers", Some("value")),
            ("salesOrders", "Erp.BO.SalesOrderSvc/SalesOrders", Some("value")),
        ],
    },
    VendorPreset {
        id: "totvs",
        label: "TOTVS Protheus",
        category: "erp",
        resources: &[
            ("customers", "customers", Some("items")),
            ("products", "products", Some("items")),
            ("orders", "orders", Some("items")),
        ],
    },
    VendorPreset {
        id: "bling",
        label: "Bling",
        category: "erp",
        resources: &[
            ("produtos", "produtos", Some("data")),
            ("pedidos", "pedidos/vendas", Some("data")),
            ("contatos", "contatos", Some("data")),
        ],
    },
    // More HR / ATS
    VendorPreset {
        id: "adp",
        label: "ADP Workforce Now",
        category: "hr",
        resources: &[("workers", "hr/v2/workers", Some("workers"))],
    },
    VendorPreset {
        id: "oracle-hcm",
        label: "Oracle HCM Cloud",
        category: "hr",
        resources: &[("workers", "workers", Some("items")), ("employees", "emps", Some("items"))],
    },
    VendorPreset {
        id: "successfactors",
        label: "SAP SuccessFactors",
        category: "hr",
        resources: &[("users", "User", Some("d.results")), ("employees", "PerPerson", Some("d.results"))],
    },
    VendorPreset {
        id: "deel",
        label: "Deel",
        category: "hr",
        resources: &[("contracts", "contracts", Some("data")), ("people", "people", Some("data"))],
    },
    VendorPreset {
        id: "hibob",
        label: "HiBob",
        category: "hr",
        resources: &[("employees", "people", Some("employees"))],
    },
    VendorPreset {
        id: "greenhouse",
        label: "Greenhouse",
        category: "hr",
        resources: &[("candidates", "candidates", None), ("jobs", "jobs", None), ("applications", "applications", None)],
    },
    VendorPreset {
        id: "lever",
        label: "Lever",
        category: "hr",
        resources: &[("candidates", "candidates", Some("data")), ("opportunities", "opportunities", Some("data"))],
    },
    VendorPreset {
        id: "workable",
        label: "Workable",
        category: "hr",
        resources: &[("jobs", "jobs", Some("jobs")), ("candidates", "candidates", Some("candidates"))],
    },
    // More CRM / sales engagement
    VendorPreset {
        id: "kommo",
        label: "Kommo (amoCRM)",
        category: "crm",
        resources: &[
            ("leads", "leads", Some("_embedded.leads")),
            ("contacts", "contacts", Some("_embedded.contacts")),
            ("companies", "companies", Some("_embedded.companies")),
        ],
    },
    VendorPreset {
        id: "pipeliner",
        label: "Pipeliner",
        category: "crm",
        resources: &[
            ("contacts", "entities/Contacts", Some("data")),
            ("accounts", "entities/Accounts", Some("data")),
            ("opportunities", "entities/Opportunities", Some("data")),
        ],
    },
    VendorPreset {
        id: "salesloft",
        label: "Salesloft",
        category: "crm",
        resources: &[("people", "people", Some("data")), ("accounts", "accounts", Some("data")), ("cadences", "cadences", Some("data"))],
    },
    VendorPreset {
        id: "outreach",
        label: "Outreach",
        category: "crm",
        resources: &[("prospects", "prospects", Some("data")), ("accounts", "accounts", Some("data")), ("sequences", "sequences", Some("data"))],
    },
    VendorPreset {
        id: "gong",
        label: "Gong",
        category: "crm",
        resources: &[("calls", "calls", Some("calls")), ("users", "users", Some("users"))],
    },
    // More support / ITSM
    VendorPreset {
        id: "freshservice",
        label: "Freshservice",
        category: "support",
        resources: &[("tickets", "tickets", Some("tickets")), ("assets", "assets", Some("assets")), ("changes", "changes", Some("changes"))],
    },
    VendorPreset {
        id: "gorgias",
        label: "Gorgias",
        category: "support",
        resources: &[("tickets", "tickets", Some("data")), ("customers", "customers", Some("data"))],
    },
    VendorPreset {
        id: "kustomer",
        label: "Kustomer",
        category: "support",
        resources: &[("customers", "customers", Some("data")), ("conversations", "conversations", Some("data"))],
    },
    VendorPreset {
        id: "helpscout",
        label: "Help Scout",
        category: "support",
        resources: &[
            ("conversations", "conversations", Some("_embedded.conversations")),
            ("mailboxes", "mailboxes", Some("_embedded.mailboxes")),
        ],
    },
    VendorPreset {
        id: "topdesk",
        label: "TOPdesk",
        category: "support",
        resources: &[("incidents", "incidents", None), ("operators", "operators", None)],
    },
    // More project / work
    VendorPreset {
        id: "basecamp",
        label: "Basecamp",
        category: "work",
        resources: &[("projects", "projects.json", None), ("todos", "todos.json", None)],
    },
    VendorPreset {
        id: "teamwork",
        label: "Teamwork",
        category: "work",
        resources: &[("projects", "projects.json", Some("projects")), ("tasks", "tasks.json", Some("tasks"))],
    },
    VendorPreset {
        id: "confluence",
        label: "Confluence",
        category: "work",
        resources: &[("pages", "content", Some("results")), ("spaces", "space", Some("results"))],
    },
    VendorPreset {
        id: "harvest",
        label: "Harvest",
        category: "work",
        resources: &[("clients", "clients", Some("clients")), ("projects", "projects", Some("projects")), ("invoices", "invoices", Some("invoices"))],
    },
    VendorPreset {
        id: "coda",
        label: "Coda",
        category: "work",
        resources: &[("docs", "docs", Some("items")), ("tables", "tables", Some("items"))],
    },
    VendorPreset {
        id: "aha",
        label: "Aha!",
        category: "work",
        resources: &[("features", "features", Some("features")), ("products", "products", Some("products")), ("ideas", "ideas", Some("ideas"))],
    },
    // More marketing
    VendorPreset {
        id: "marketo",
        label: "Marketo",
        category: "marketing",
        resources: &[("leads", "leads", Some("result")), ("campaigns", "campaigns", Some("result"))],
    },
    VendorPreset {
        id: "brevo",
        label: "Brevo (Sendinblue)",
        category: "marketing",
        resources: &[("contacts", "contacts", Some("contacts")), ("campaigns", "emailCampaigns", Some("campaigns"))],
    },
    VendorPreset {
        id: "sendgrid",
        label: "SendGrid",
        category: "marketing",
        resources: &[("contacts", "marketing/contacts", Some("result")), ("lists", "marketing/lists", Some("result"))],
    },
    VendorPreset {
        id: "constantcontact",
        label: "Constant Contact",
        category: "marketing",
        resources: &[("contacts", "contacts", Some("contacts")), ("lists", "contact_lists", Some("lists"))],
    },
    // More e-commerce
    VendorPreset {
        id: "magento",
        label: "Magento / Adobe Commerce",
        category: "ecommerce",
        resources: &[
            ("products", "products", Some("items")),
            ("orders", "orders", Some("items")),
            ("customers", "customers/search", Some("items")),
        ],
    },
    VendorPreset {
        id: "ecwid",
        label: "Ecwid",
        category: "ecommerce",
        resources: &[("products", "products", Some("items")), ("orders", "orders", Some("items"))],
    },
    VendorPreset {
        id: "etsy",
        label: "Etsy",
        category: "ecommerce",
        resources: &[("listings", "listings/active", Some("results")), ("receipts", "receipts", Some("results"))],
    },
    // More payments / billing
    VendorPreset {
        id: "square",
        label: "Square",
        category: "billing",
        resources: &[("customers", "customers", Some("customers")), ("orders", "orders", Some("orders")), ("payments", "payments", Some("payments"))],
    },
    VendorPreset {
        id: "paddle",
        label: "Paddle",
        category: "billing",
        resources: &[("subscriptions", "subscriptions", Some("data")), ("transactions", "transactions", Some("data"))],
    },
    VendorPreset {
        id: "gocardless",
        label: "GoCardless",
        category: "billing",
        resources: &[("customers", "customers", Some("customers")), ("payments", "payments", Some("payments"))],
    },
    VendorPreset {
        id: "zuora",
        label: "Zuora",
        category: "billing",
        resources: &[("accounts", "accounts", Some("records")), ("subscriptions", "subscriptions", Some("records"))],
    },
    // Comms / docs / e-sign
    VendorPreset {
        id: "slack",
        label: "Slack",
        category: "collaboration",
        resources: &[("channels", "conversations.list", Some("channels")), ("users", "users.list", Some("members"))],
    },
    VendorPreset {
        id: "box",
        label: "Box",
        category: "collaboration",
        resources: &[("items", "folders/0/items", Some("entries"))],
    },
    VendorPreset {
        id: "dropbox",
        label: "Dropbox",
        category: "collaboration",
        resources: &[("files", "files/list_folder", Some("entries"))],
    },
    VendorPreset {
        id: "docusign",
        label: "DocuSign",
        category: "collaboration",
        resources: &[("envelopes", "envelopes", Some("envelopes"))],
    },
    VendorPreset {
        id: "calendly",
        label: "Calendly",
        category: "collaboration",
        resources: &[("events", "scheduled_events", Some("collection"))],
    },
    // Forms / survey
    VendorPreset {
        id: "typeform",
        label: "Typeform",
        category: "forms",
        resources: &[("forms", "forms", Some("items")), ("responses", "responses", Some("items"))],
    },
    VendorPreset {
        id: "surveymonkey",
        label: "SurveyMonkey",
        category: "forms",
        resources: &[("surveys", "surveys", Some("data")), ("responses", "responses", Some("data"))],
    },
    VendorPreset {
        id: "jotform",
        label: "Jotform",
        category: "forms",
        resources: &[("forms", "user/forms", Some("content")), ("submissions", "user/submissions", Some("content"))],
    },
];

/// Look up a packaged preset by vendor id.
pub fn find(id: &str) -> Option<&'static VendorPreset> {
    CATALOG.iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector::Connector;

    #[test]
    fn catalog_includes_softexpert_with_resources() {
        let se = find("softexpert").expect("softexpert preset present out of the box");
        assert_eq!(se.label, "SoftExpert Suite");
        assert_eq!(se.category, "bpm-grc");
        let resources = se.resources();
        let names: Vec<&str> = resources.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"workflow"));
        assert!(names.contains(&"risk"));
    }

    #[test]
    fn resource_names_lists_the_preset_objects() {
        // Drives the Source-pane catalog "contributes" blurb (#1288).
        let se = find("softexpert").unwrap();
        let names = se.resource_names();
        assert!(names.contains(&"workflow") && names.contains(&"risk"));
        assert_eq!(names.len(), se.resources().len());
    }

    #[test]
    fn catalog_is_non_trivial_and_ids_unique() {
        assert!(CATALOG.len() >= 10, "ship a meaningful out-of-the-box catalog");
        let mut ids: Vec<&str> = CATALOG.iter().map(|p| p.id).collect();
        ids.sort();
        let len = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), len, "vendor ids must be unique");
        assert!(find("does-not-exist").is_none());
    }

    #[test]
    fn preset_builds_a_working_connector() {
        let se = find("softexpert").unwrap();
        // SoftExpert resources are bare arrays (array_key = None).
        let c = se.connector("acme-se", move |_path| {
            Ok(serde_json::json!([
                {"id": 1, "name": "Onboarding", "status": "active"},
                {"id": 2, "name": "Offboarding", "status": "draft"}
            ]))
        });
        let objs = c.objects().unwrap();
        assert!(objs.iter().any(|o| o.name == "workflow"));
        let rs = c.read("workflow").unwrap();
        assert_eq!(rs.rows.len(), 2);
        assert_eq!(rs.columns, vec!["id", "name", "status"]);
    }
}
