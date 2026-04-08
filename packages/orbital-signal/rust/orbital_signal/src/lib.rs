#[uniffi::export]
fn hello_orbital(name: String) -> String {
    format!("Hello from Orbital Signal, {}!", name)
}

uniffi::setup_scaffolding!();
