Rust native worker placeholder

This folder is a placeholder for a Rust crate that will provide high-performance transforms and analysis.

Planned layout:
- native/worker/Cargo.toml
- native/worker/src/lib.rs
- native/bridge/ - Node.js bridge to call the native binary via stdio or FFI

For the prototype, native worker will be optional and can be compiled separately.
