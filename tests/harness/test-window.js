// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

// Provide a maximized GTK test window for --window harness runs. Its diagonal
// stripes make blur and translucency easy to compare, and it restores to
// 400×240 so it can sit beside the dock.
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

const CSS = `
window.basedock-test {
    background-image: repeating-linear-gradient(45deg,
        #1c71d8 0px, #1c71d8 14px, #ffffff 14px, #ffffff 28px);
}
label.basedock-test {
    font-size: 20px;
    font-weight: bold;
    color: #000000;
    background-color: #f6d32d;
    padding: 6px 10px;
}
`;

const app = new Gtk.Application({application_id: 'org.basedock.TestWindow'});
app.connect('activate', () => {
    const provider = new Gtk.CssProvider();
    provider.load_from_string(CSS);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(),
        provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

    const count = app.get_windows().length;
    const title = ['basedock test window', 'basedock second test window',
        'basedock third test window'][count] ?? 'basedock additional test window';
    const win = new Gtk.ApplicationWindow({
        application: app,
        title,
        default_width: 400,
        default_height: 240,
        css_classes: ['basedock-test'],
    });
    const label = new Gtk.Label({
        label: 'basedock test window',
        css_classes: ['basedock-test'],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    });
    win.set_child(label);
    if (count === 0)
        win.maximize();
    win.present();
});
app.run([]);
