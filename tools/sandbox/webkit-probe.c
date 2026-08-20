// Does webkit2gtk-4.1 give us WebGL2 with instanced drawing?
//
// Tauri on Linux renders through wry -> webkit2gtk-4.1 (GTK3), NOT Chromium/WebView2. That is a
// different engine with different capabilities, and the graph renderer's whole design rests on
// one instanced draw call for N nodes. This answers the question directly instead of assuming
// Chromium behaviour carries over.
//
// The page posts its findings back over a script-message handler, so the result lands on stdout
// as JSON rather than only being visible on screen.
//
//   gcc -o /tmp/webkit-probe tools/sandbox/webkit-probe.c \
//       $(pkg-config --cflags --libs webkit2gtk-4.1 gtk+-3.0)
//   /tmp/webkit-probe file://$PWD/tools/sandbox/webkit-probe.html
//
// Plan: phase-2-kernel-isolation-replaces-the-hook-floor (slice 1)
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <stdio.h>

static int got = 0;

static void on_msg(WebKitUserContentManager *cm, WebKitJavascriptResult *res, gpointer user) {
    (void)cm; (void)user;
    JSCValue *v = webkit_javascript_result_get_js_value(res);
    char *s = jsc_value_to_string(v);
    printf("%s\n", s);
    g_free(s);
    got = 1;
    gtk_main_quit();
}

static gboolean bail(gpointer d) {
    (void)d;
    if (!got) printf("{\"fatal\":\"timeout - no probe message received\"}\n");
    gtk_main_quit();
    return FALSE;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: webkit-probe <file-uri>\n"); return 2; }
    gtk_init(&argc, &argv);

    WebKitUserContentManager *cm = webkit_user_content_manager_new();
    webkit_user_content_manager_register_script_message_handler(cm, "probe");
    g_signal_connect(cm, "script-message-received::probe", G_CALLBACK(on_msg), NULL);

    WebKitWebView *view = WEBKIT_WEB_VIEW(webkit_web_view_new_with_user_content_manager(cm));
    WebKitSettings *st = webkit_web_view_get_settings(view);
    webkit_settings_set_enable_webgl(st, TRUE);
    webkit_settings_set_hardware_acceleration_policy(st, WEBKIT_HARDWARE_ACCELERATION_POLICY_ALWAYS);
    webkit_settings_set_enable_write_console_messages_to_stdout(st, TRUE);

    // The view must be realized for a GL context to exist, so this needs a display.
    GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_default_size(GTK_WINDOW(win), 400, 300);
    gtk_container_add(GTK_CONTAINER(win), GTK_WIDGET(view));
    gtk_widget_show_all(win);

    webkit_web_view_load_uri(view, argv[1]);
    g_timeout_add_seconds(25, bail, NULL);
    gtk_main();
    return got ? 0 : 1;
}
