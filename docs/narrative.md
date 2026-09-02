# Android Mobile Application Narrative — Rented Gas Cylinder Tracking System

_Extracted verbatim from `Gas_Cylinder_Tracking_Mobile_App_Narrative_v2.docx` for version control. The .docx remains the source of record._

## 1. Mobile Application Overview & Scope

An Android application for field technicians, store managers, and logistics
personnel to track rented gas cylinders across project lifecycles. It interfaces
with a centralized web-server database for real-time inventory visibility,
location tracking, automated serial generation, and driver signature verification
on returns.

### 1.1 Primary Mobile User Personas

| User Role                         | Primary Responsibilities & Key Mobile Interactions                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Field Technician / Site Operative | Logs initial intake of new cylinder batches, scans individual cylinder QR codes, initiates transfers.                        |
| Stores Manager                    | Manages batch collection, scans incoming QR codes during returns, captures driver signatures, issues digital delivery notes. |
| Collection / Logistics Driver     | Provides physical sign-off via digital signature capture during cylinder returns.                                            |

## 2. System Glossary

| Term                 | Definition & Context                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Project Number       | Unique alphanumeric identifier for a client contract / engineering job / active site engagement.                                     |
| Project Manager (PM) | Site oversight lead. Receives automated emails containing generated QR codes and digital delivery notes. **Not an app user.**        |
| Site / Location      | Physical operational destination where cylinders are deployed, stored, or used.                                                      |
| Active Batch         | A grouped shipment of cylinders linked to a Project Number that remains deployed (not yet returned).                                 |
| Unique Serial Code   | System-generated identifier `[TYPE][YEAR]-[SEQ]` (e.g. `NIT26-001`) uniquely identifying one physical cylinder across its lifecycle. |
| Delivery Note        | Auto-generated PDF receipt emailed to the PM on return, detailing cylinder serials, timestamps, and collection-driver sign-off.      |

## 3. Architecture & Main Navigation

- **3.1 Authentication Screen** — secure login with corporate credentials, token-based session validation.
- **3.2 Main Dashboard** — a streamlined 3-button dashboard:
  - **New** — batch creation; set up a new site or add batches to an existing site; generates serials and QR codes.
  - **Transfer** — relocation of active cylinders between project sites or back to stores; enforces QR verification scanning.
  - **Returns** — final return workflows; physical QR verification scanning, driver sign-off, delivery-note generation.

## 4. Detailed Operational Workflows

### Workflow A — 'New' Batch Creation & QR Generation

1. **Site Mode Selection** — tapping 'New' prompts: _Create New Site_ (full new site + project init) or _Edit Existing Site_ (attach batches to an existing active project/site).
2. **2A Create New Site** — inputs: Project Number (new), Project Manager (name / email), Site Name & Location.
   **2B Edit Existing Site** — search & select an existing Project Number or Site; system auto-populates PM and Site details; user adds new batches.
3. **Cylinder Line-Item Entry** — add line items to the batch: Gas Type (e.g. Nitrogen, Argon), Supplier Name, Quantity, Initial Delivery Point.
4. **Unique Serial Code Call** — for each cylinder unit, the app calls the central backend API to assign a globally unique serial: `[GAS_PREFIX][YEAR]-[SEQ_NUM]` (e.g. `NIT26-001`).
5. **Automated QR Dispatch** — the server generates unique QR codes for each unit and emails a printable QR-code PDF sheet directly to the designated Project Manager for physical tagging.

### Workflow B — 'Transfer' Cylinder Relocation

1. **Search & Filter Active Batches** — by Project Number OR Project Manager Name.
2. **Active Batch Selection.**
3. **Mandatory Physical QR Verification (Scanning)** — CRITICAL ENFORCEMENT: the app opens the camera scanner; the user MUST scan each physical cylinder's QR code intended for transfer before the system permits final submission.
4. **Destination Selection** — New Site or Back to Stores.
5. **Server Sync** — updates the central database in real time with a timestamped audit log.

### Workflow C — 'Returns' & Driver Sign-Off

1. **Search Active Batches** — Stores Manager searches by Project Manager Name or Project Number.
2. **Active Batch Selection.**
3. **Cylinder Verification Scanning** — Stores Manager scans individual physical QR codes for return validation.
4. **Driver On-Screen Signature Capture** — digital signature canvas captures driver sign-off.
5. **Status Finalization & Automated Delivery Note** — updates server status to 'Returned' and emails a PDF Delivery Note to the Project Manager.

## 5. Claude Prompting Technical Guidelines (from the spec)

1. **Database Schema** — support existing-site lookups; enforce unique constraints on Serial Numbers (`TYPEYY-XXX`).
2. **Dynamic Prompts** — secondary prompt modal/selector for Create vs. Edit Site under New Batch.
3. **Hardware Features** — Android Camera API / barcode scanning (e.g. ZXing / ML Kit).
4. **Offline Resilience** — local SQLite/Room caching for QR scanning prior to backend dispatch.
5. **Mailer API** — backend integration (e.g. SendGrid / NodeMailer) for automated PDF/QR emailing.
