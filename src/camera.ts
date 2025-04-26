export interface CameraState {
    motion_enabled?: boolean;
    detect_enabled?: boolean;
    task?: 'normal' | 'homing' | 'patrolling';
    sees_objects?: boolean;
}

export class FrigateCamera {
    name: string;
    motion_enabled: boolean = false;
    detect_enabled: boolean = false;
    task: 'normal' | 'homing' | 'patrolling' = 'normal';
    sees_objects: boolean = false;

    constructor(name: string) {
        this.name = name;
    }

    getName(): string {
        return this.name;
    }

    /**
     * The topic where the camera will publish if object detection is enabled or not.
     * @param root Root topic name for MQTT
     * @returns The MQTT topic where 'ON' or 'OFF' will be published
     */
    getDetectStateTopic(root = "frigate"): string {
        return `${root}/${this.name}/detect/state`;
    }
    /**
     * Note: Must be disabled before disabling motion detection.
     * @param root Root topic name for MQTT
     * @returns The MQTT topic used for enabling/disabling object detection
     */
    getDetectSetTopic(root = "frigate"): string {
        return `${root}/${this.name}/detect/set`;
    }
    /**
     * The topic where the camera will publish if motion detection is enabled or not.
     * @param root Root topic name for MQTT
     * @returns The MQTT topic where 'ON' or 'OFF' will be published
     */
    getMotionStateTopic(root = "frigate"): string {
        return `${root}/${this.name}/motion/state`;
    }
    /**
     * Note: Detection MUST be disabled to also disable motion detection.
     * @param root Root topic name for MQTT
     * @returns The MQTT topic used for enabling/disabling motion detection
     */
    getMotionSetTopic(root = "frigate"): string {
        return `${root}/${this.name}/motion/set`;
    }

    /**
     * The topic that Frigate listens for instructions on what to do with a PTZ-enabled camera.
     * @param root Root topic name for MQTT
     * @returns The MQTT topic where PTZ commands can be sent
     */
    getPtzTopic(root = "frigate"): string {
        return `${root}/${this.name}/ptz`;
    }

    /**
     * Update the state of the camera given an MQTT client to ask
     * @param newstate The new state to set
     * @returns true if the state was updated, false otherwise
     */
    setCameraState(newstate: CameraState): boolean {
        let updated = false;
        if (newstate.motion_enabled !== undefined && newstate.motion_enabled !== this.motion_enabled) {
            this.motion_enabled = newstate.motion_enabled;
            updated = true;
        }
        if (newstate.detect_enabled !== undefined && newstate.detect_enabled !== this.detect_enabled) {
            this.detect_enabled = newstate.detect_enabled;
            updated = true;
        }
        if (newstate.task !== undefined && newstate.task !== this.task) {
            this.task = newstate.task;
            updated = true;
        }
        if (newstate.sees_objects !== undefined && newstate.sees_objects !== this.sees_objects) {
            this.sees_objects = newstate.sees_objects;
            updated = true;
        }
        return updated;
    }
}
