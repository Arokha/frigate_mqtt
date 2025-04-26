export interface CameraState {
    motion_enabled?: boolean;
    detect_enabled?: boolean;
    task?: 'normal' | 'homing' | 'patrolling';
}

export class FrigateCamera {
    name: string;
    motion_enabled: boolean = false;
    detect_enabled: boolean = false;
    task: 'normal' | 'homing' | 'patrolling' = 'normal';

    constructor(name: string, mqtt_url: string = 'localhost', mqtt_port: number = 1883) {
        this.name = name;
    }

    getName(): string {
        return this.name;
    }

    /**
     * The topic where the camera will publish changes to the object detection state.
     * @param root Root topic name for MQTT
     * @returns The MQTT topic where 'ON' or 'OFF' will be published
     */
    getDetectUpdateTopic(root = "frigate"): string {
        return `${root}/${this.name}/detect`;
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
     * The topic where the camera will publish changes to the motion detection state.
     * @param root Root topic name for MQTT
     * @returns The MQTT topic where 'ON' or 'OFF' will be published
     */
    getMotionUpdateTopic(root = "frigate"): string {
        return `${root}/${this.name}/motion`;
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
        return updated;
    }
}