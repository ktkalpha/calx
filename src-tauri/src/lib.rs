mod kernel;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(kernel::KernelState::default())
        .invoke_handler(tauri::generate_handler![
            kernel::kernel_start,
            kernel::kernel_send,
            kernel::kernel_interrupt,
            kernel::kernel_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building calx")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                kernel::kill(&app.state::<kernel::KernelState>());
            }
        });
}
