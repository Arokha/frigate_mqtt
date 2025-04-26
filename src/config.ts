import { z } from "zod";

export const configSchema = z.object({
    "mqtt_url": z.string().default("mqtt://localhost"),
    "mqtt_port": z.number().default(1883),
    "mqtt_root": z.string().default("frigate"),
    "cameras": z.array(z.object({
        "name": z.string(),
        "rehome_slew_time": z.number().default(0), // Because we rehome often, even when already home'd, we may want to avoid 'gaps' in coverage
        "rehome": z.boolean().default(true),
        "rehome_after": z.number().default(120),
        "rehome_preset": z.string().default("1"),
        "patrols": z.boolean().default(false),
        "patrol_every": z.number().default(3600),
        "patrol_route": z.array(z.string()).default(['1']),
        "patrol_dwell": z.number().default(30),
        "patrol_slew_time": z.number().default(10),
        "want_motion": z.boolean().default(true),
        "want_detect": z.boolean().default(true),
    }))
});

export type Config = z.infer<typeof configSchema>;
