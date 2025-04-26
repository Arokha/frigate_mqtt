import { z } from "zod";

// JSON object like this with every camera as a key in the top object:
// {"camera_name": {"motion": false, "objects": [], "config": {"detect": true, "snapshots": false, "record": true, "audio": false, "autotracking": false}}, "camera_name2": {...}}
// Note the "motion" and "objects" are what is CURRENTLY SENSED by the camera, not the config, unlike the "config" object

export const frigateStateSchema = z.record(z.string(), z.object({
    motion: z.boolean(),
    objects: z.array(z.any()),
    config: z.object({
        detect: z.boolean(),
        snapshots: z.boolean(),
        record: z.boolean(),
        audio: z.boolean(),
        autotracking: z.boolean()
    })
}));

export type FrigateState = z.infer<typeof frigateStateSchema>;
