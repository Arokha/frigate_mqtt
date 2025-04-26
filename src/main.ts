import { connect, MqttClient } from "mqtt";
import { FrigateCamera, CameraState } from "./camera.ts";
import { readFileSync } from "fs";
import { parse as yamlParse } from "yaml";
import { configSchema } from "./config.ts";
import { frigateStateSchema, FrigateState } from "./frigate.ts";

// Read config from config.yaml file
const configFile = readFileSync("config.yml", "utf8");
const config = configSchema.parse(yamlParse(configFile));

// Create an array of FrigateCamera instances based on the config
const cameras = config.cameras.map((cameraConfig) => {
    const camera = new FrigateCamera(cameraConfig.name);
    return camera;
});

// Connect to the MQTT broker
let connected_to_broker = false;
let broker: MqttClient;

/**
 * Sends a message to a topic and waits for a response on another topic
 * @param publishTopic Topic to publish to
 * @param subscribeTopic Topic to listen for response on
 * @param message Message to publish
 * @param timeout Timeout in milliseconds
 * @returns Promise that resolves with the response message or rejects on timeout
 */
function sendAndWaitForResponse(
    publishTopic: string, 
    subscribeTopic: string, 
    message: string, 
    timeout: number = 5000
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        // Set up a one-time listener for the response
        const responseHandler = (topic: string, responseMessage: Buffer) => {
            if (topic === subscribeTopic) {
                broker.removeListener('message', responseHandler);
                clearTimeout(timeoutId);
                resolve(responseMessage);
            }
        };
        
        broker.on('message', responseHandler);
        
        // Set up a timeout
        const timeoutId = setTimeout(() => {
            broker.removeListener('message', responseHandler);
            reject(new Error(`Timeout waiting for response on ${subscribeTopic}`));
        }, timeout);
        
        // Publish the message
        broker.publish(publishTopic, message, { qos: 1 }, (err) => {
            if (err) {
                broker.removeListener('message', responseHandler);
                clearTimeout(timeoutId);
                reject(err);
            }
        });
    });
}

/**
 * Connect to the MQTT broker and set up event handlers
 */
function connectToBroker(): void {
    // Close any existing connections
    if (broker) {
        try {
            broker.end(true);
        } catch (e) {
            // Ignore errors from ending the broker
        }
    }
    
    // Connect to the MQTT broker
    broker = connect(config.mqtt_url, {port: config.mqtt_port});
    
    // Set up event handlers
    broker.on("connect", handleConnect);
    broker.on("error", handleError);
    broker.on("close", handleClose);
    broker.on("message", handleMessage);
}

/**
 * Handle broker connect event
 */
function handleConnect(): void {
    console.log("[MAIN] Connected to MQTT broker");
    connected_to_broker = true;
    
    // Subscribe to required topics
    setupSubscriptions();
    
    // Initial poke to get camera states
    pokeFrigate().catch(err => {
        console.error("[MAIN] Error during initial poke:", err);
    });
}

/**
 * Handle broker error event
 */
function handleError(err: Error): void {
    console.error("[MAIN] Error connecting to MQTT broker:", err);
    connected_to_broker = false;
}

/**
 * Handle broker close event
 */
function handleClose(): void {
    console.log("[MAIN] Connection to MQTT broker closed");
    connected_to_broker = false;
}

/**
 * Set up subscriptions to required topics
 */
function setupSubscriptions(): void {
    // Subscribe to camera_activity topic
    broker.subscribe(`${config.mqtt_root}/camera_activity`, { qos: 1 }, (err) => {
        if (err) {
            console.error(`[MAIN] Error subscribing to ${config.mqtt_root}/camera_activity:`, err);
        } else {
            console.log(`[MAIN] Subscribed to ${config.mqtt_root}/camera_activity`);
        }
    });

    // Subscribe to individual camera topics
    const cameraTopics = cameras.map((camera) => {
        return [
            camera.getDetectStateTopic(config.mqtt_root),
            camera.getMotionStateTopic(config.mqtt_root),
        ];
    }).flat();
    broker.subscribe(cameraTopics, { qos: 1 }, (err) => {
        if (err) {
            console.error(`[MAIN] Error subscribing to camera topics:`, err);
        } else {
            console.log(`[MAIN] Subscribed to camera topics`);
        }
    });
}

// Initialize the connection
connectToBroker();

// Wait for connection to be established
(async function waitForConnection() {
    while(!connected_to_broker) {
        console.log("[MAIN] Waiting for connection to MQTT broker...");
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
})();

// Global variables for the health check
let healthCheckInterval: NodeJS.Timeout;
const HEALTH_CHECK_INTERVAL = 60000; // 60 seconds

/**
 * Set up the periodic health check that pokes the broker
 */
function setupHealthCheck(): void {
    // Clear any existing interval
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
    }
    
    // Set up a new interval
    healthCheckInterval = setInterval(() => {
        pokeFrigate().catch(err => {
            console.error("[MAIN] Error during scheduled poke:", err);
        });
    }, HEALTH_CHECK_INTERVAL);
    
    //console.log(`Set up health check to poke broker every ${HEALTH_CHECK_INTERVAL / 1000} seconds`);
}

/**
 * Force a camera state update and get the latest detected objects
 * @param camera The camera to get state for
 * @param resetInterval Whether to reset the health check interval (default: true)
 * @returns Promise that resolves when the state has been updated
 */
async function refreshCameraState(camera: FrigateCamera, resetInterval: boolean = true): Promise<void> {
    console.log(`[CAM:${camera.getName()}] Refreshing state`);
    
    try {
        // Poke the broker to get latest camera states
        await pokeFrigate();
        
        // Reset the health check interval to avoid duplicate pokes
        if (resetInterval) {
            setupHealthCheck();
        }
        
    } catch (error) {
        console.error(`[CAM:${camera.getName()}] Error refreshing state:`, error);
        throw error;
    }
}

/**
 * Handle incoming messages from the broker
 */
function handleMessage(topic: string, message: Buffer): void {
    if(!topic.startsWith(config.mqtt_root+"/")) {
        // Ignore messages that don't start with the root topic
        return;
    }

    // Trim the root from the topic string
    const trimmedTopic = topic.substring(config.mqtt_root.length + 1);

    // JSON object like this with every camera as a key in the top object:
    // {"camera_name": {"motion": false, "objects": [], "config": {"detect": true, "snapshots": false, "record": true, "audio": false, "autotracking": false}}}
    // Note the "motion" and "objects" are what is CURRENTLY SENSED by the camera, not the config, unlike the "config" object
    if(trimmedTopic === "camera_activity") {
        console.log("[MAIN] Received camera_activity message:", message.toString());
        try {
            const rawStates = JSON.parse(message.toString());
            // If Frigate returns only a {} then it is not done coming up yet
            if (Object.keys(rawStates).length === 0) {
                console.log("[MAIN] Received empty camera_activity message, ignoring...");
                return;
            }
            // Validate the structure of the received data
            const parsedStates = frigateStateSchema.parse(rawStates);
            for (const cameraName in parsedStates) {
                const cameraState = parsedStates[cameraName];
                const camera = cameras.find((cam) => cam.getName() === cameraName);
                if (camera) {
                    // Update the camera state with both detect config and detected objects
                    camera.setCameraState({
                        detect_enabled: cameraState.config.detect,
                        sees_objects: Boolean(cameraState.objects.length)
                    });
                    console.log(`[CAM:${cameraName}] Updated state, detected objects: ${cameraState.objects.length > 0 ? cameraState.objects.join(', ') : 'none'}`);
                }
            }
        } catch (error) {
            console.error("[MAIN] Error parsing camera_activity message:", error);
        }
        return;
    }
    // Split the topic on / to see if it has a camera name with the first part (or only part)
    const topicParts = trimmedTopic.split("/");
    const cameraName = topicParts[0];
    const camera = cameras.find((cam) => cam.getName() === cameraName);
    if (!camera) {
        // Don't log anything, there are MANY other topics that are not camera topics
        return;
    }

    // Could be a camera status update. Of those, the ones we care about are 'motion' and 'detect'
    // If it is an update from one of those, there will be a 3rd part as well, 'state'. Those are the only ones we care about.
    if (topicParts.length === 3 && topicParts[1] === "state") {
        const category = topicParts[2];
        const state = message.toString();
        switch (category) {
            case "motion":
                // Update the camera state
                camera.setCameraState({motion_enabled: state === "ON"});
                console.log(`[CAM:${cameraName}] Updated motion state: ${state}`);
                break;
            case "detect":
                // Update the camera state
                camera.setCameraState({detect_enabled: state === "ON"});
                console.log(`[CAM:${cameraName}] Updated detect state: ${state}`);
                break;
        }
    }
}

/**
 * If Frigate is running, it will publish to the frigate/camera_activity topic on receiving a message on frigate/onConnect
 * This function will wait for a response on the camera_activity topic and reject if none is received within the timeout
 */
async function pokeFrigate(): Promise<void> {
    try {
        await sendAndWaitForResponse(
            `${config.mqtt_root}/onConnect`,
            `${config.mqtt_root}/camera_activity`,
            "poke",
            5000
        );
        console.log("[MAIN] Successfully received response from Frigate");
    } catch (error) {
        console.error("[MAIN] Error communicating with Frigate:", error);
        
        // If we've lost connection, try to reconnect
        console.log("[MAIN] Connection appears to be dead. Attempting to reconnect...");
        connected_to_broker = false;
        broker.end(true);
        
        // Attempt to reconnect
        connectToBroker();
        throw error; // Re-throw to allow caller to handle
    }
}

/**
 * Set the camera's detect state and wait for confirmation
 * @param camera The camera to set the detect state for
 * @param state The state to set (true for ON, false for OFF)
 * @returns Promise that resolves with true if successful, false otherwise
 */
async function setCameraDetect(camera: FrigateCamera, state: boolean): Promise<boolean> {
    const publishTopic = camera.getDetectSetTopic(config.mqtt_root);
    const subscribeTopic = camera.getDetectStateTopic(config.mqtt_root);
    const message = state ? "ON" : "OFF";
    
    try {
        const response = await sendAndWaitForResponse(publishTopic, subscribeTopic, message, 5000);
        const responseStr = response.toString();
        console.log(`[CAM:${camera.getName()}] Received response for detect: ${responseStr}`);
        
        // Verify the response matches what we expect
        if (responseStr === message) {
            camera.setCameraState({ detect_enabled: state });
            return true;
        } else {
            console.error(`[CAM:${camera.getName()}] Unexpected response for detect: expected ${message}, got ${responseStr}`);
            return false;
        }
    } catch (error) {
        console.error(`[CAM:${camera.getName()}] Error setting detect state:`, error);
        
        // If we've lost connection, try to reconnect
        console.log("[MAIN] Connection appears to be dead. Attempting to reconnect...");
        connected_to_broker = false;
        broker.end(true);
        
        // Attempt to reconnect
        connectToBroker();
        return false;
    }
}

/**
 * Set the camera's motion state and wait for confirmation
 * @param camera The camera to set the motion state for
 * @param state The state to set (true for ON, false for OFF)
 * @returns Promise that resolves with true if successful, false otherwise
 */
async function setCameraMotion(camera: FrigateCamera, state: boolean): Promise<boolean> {
    const publishTopic = camera.getMotionSetTopic(config.mqtt_root);
    const subscribeTopic = camera.getMotionStateTopic(config.mqtt_root);
    const message = state ? "ON" : "OFF";
    
    try {
        const response = await sendAndWaitForResponse(publishTopic, subscribeTopic, message, 5000);
        const responseStr = response.toString();
        console.log(`[CAM:${camera.getName()}] Received response for motion: ${responseStr}`);
        
        // Verify the response matches what we expect
        if (responseStr === message) {
            camera.setCameraState({ motion_enabled: state });
            return true;
        } else {
            console.error(`[CAM:${camera.getName()}] Unexpected response for motion: expected ${message}, got ${responseStr}`);
            return false;
        }
    } catch (error) {
        console.error(`[CAM:${camera.getName()}] Error setting motion state:`, error);
        
        // If we've lost connection, try to reconnect
        console.log("[MAIN] Connection appears to be dead. Attempting to reconnect...");
        connected_to_broker = false;
        broker.end(true);
        
        // Attempt to reconnect
        connectToBroker();
        return false;
    }
}

/**
 * Sends a PTZ preset command to a camera
 * @param camera The camera to send the PTZ command to
 * @param presetName The name of the preset to move to
 * @returns Promise that resolves when the command is sent
 */
async function setCameraPtzPreset(camera: FrigateCamera, presetName: string): Promise<boolean> {
    const ptzTopic = camera.getPtzTopic(config.mqtt_root);
    const message = `preset_${presetName}`;
    
    try {
        // Publish the message and return a promise that resolves when published
        await new Promise<void>((resolve, reject) => {
            broker.publish(ptzTopic, message, { qos: 1 }, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
        
        console.log(`[CAM:${camera.getName()}] Sent PTZ preset command: ${message}`);
        camera.setCameraState({ task: 'homing' }); // Update the camera state
        return true;
    } catch (error) {
        console.error(`[CAM:${camera.getName()}] Error sending PTZ preset command:`, error);
        
        // Check if this is a connection issue
        if (!connected_to_broker) {
            // If we've lost connection, try to reconnect
            console.log("[MAIN] Connection appears to be dead. Attempting to reconnect...");
            broker.end(true);
            connectToBroker();
        }
        return false;
    }
}

/**
 * Safely move a camera to a preset position by:
 * 1. Disabling object detection
 * 2. Disabling motion detection
 * 3. Moving to the preset
 * 4. Re-enabling motion detection
 * 5. Re-enabling object detection
 * 
 * @param camera The camera to move
 * @param presetName The preset position name to move to
 * @param restoreDetection Whether to restore detection settings after movement (default: true)
 * @returns Promise that resolves with true if all operations succeeded
 */
async function safeMoveCameraToPreset(
    camera: FrigateCamera, 
    presetName: string, 
): Promise<boolean> {
    console.log(`[CAM:${camera.getName()}] Safely moving to preset ${presetName}...`);

    const cameraConfig = config.cameras.find(c => c.name === camera.getName());
    if (!cameraConfig) {
        console.error(`[CAM:${camera.getName()}] Could not find configuration for camera ${camera.getName()}`);
        return false;
    }
    const slewTime = cameraConfig.slew_time;
    
    // Store original detection states to restore later if needed
    const originalDetectState = camera.detect_enabled;
    const originalMotionState = camera.motion_enabled;
    console.log(`[CAM:${camera.getName()}] Pre-move detect state: ${originalDetectState}, motion state: ${originalMotionState}`);
    
    // Step 1: Disable object detection
    if (originalDetectState) {
        console.log(`[CAM:${camera.getName()}] Disabling object detection...`);
        const detectResult = await setCameraDetect(camera, false);
        if (!detectResult) {
            console.error(`[CAM:${camera.getName()}] Failed to disable object detection`);
            return false;
        }
    }
    
    // Step 2: Disable motion detection
    if (originalMotionState) {
        console.log(`[CAM:${camera.getName()}] Disabling motion detection...`);
        const motionResult = await setCameraMotion(camera, false);
        if (!motionResult) {
            console.error(`[CAM:${camera.getName()}] Failed to disable motion detection`);
            // Try to restore original detection state
            if (originalDetectState) {
                await setCameraDetect(camera, true);
            }
            return false;
        }
    }
    
    // Step 3: Move to preset
    console.log(`[CAM:${camera.getName()}] Moving to preset ${presetName}...`);
    const ptzResult = await setCameraPtzPreset(camera, presetName);
    if (!ptzResult) {
        console.error(`[CAM:${camera.getName()}] Failed to move to preset ${presetName}`);
        // Try to restore original states
        if (originalMotionState) {
            await setCameraMotion(camera, true);
        }
        if (originalDetectState) {
            await setCameraDetect(camera, true);
        }
        return false;
    }
    
    // Wait for camera to finish moving before re-enabling detection
    console.log(`[CAM:${camera.getName()}] Waiting ${slewTime}s for camera movement to complete...`);
    await new Promise(resolve => setTimeout(resolve, slewTime*1000));
    
    // Step 4: Re-enable motion detection
    if (originalMotionState) {
        console.log(`[CAM:${camera.getName()}] Re-enabling motion detection...`);
        await setCameraMotion(camera, true);
    }
    
    // Step 5: Re-enable object detection
    if (originalDetectState) {
        console.log(`[CAM:${camera.getName()}] Re-enabling object detection...`);
        await setCameraDetect(camera, true);
    }
    
    console.log(`[CAM:${camera.getName()}] Finished move commands for preset ${presetName}`);
    return true;
}

/**
 * Move a camera through a sequence of preset positions
 * @param camera The camera to move
 * @param presetNames Array of preset names to move through
 * @param dwellTime Milliseconds to wait at each position (default: 10000 - 10 seconds)
 * @param maxRetries Number of times to check for objects before moving on (default: 3)
 * @returns Promise that resolves when patrol is complete
 */
async function patrolCameraPresets(
    camera: FrigateCamera,
    presetNames: string[],
    dwellTime: number = 30 * 1000, // Time to wait at each preset
    maxRetries: number = 10
): Promise<boolean> {
    console.log(`[CAM:${camera.getName()}] Starting patrol through ${presetNames.length} positions`);
    camera.setCameraState({ task: 'patrolling' });
    
    // First preset - disable detection but don't restore yet
    if (presetNames.length > 0) {
        // Get the latest camera state before starting patrol
        try {
            await refreshCameraState(camera);
            
            // Check if there are objects detected
            if (camera.sees_objects) {
                console.log(`[CAM:${camera.getName()}] Skipping patrol because objects are detected`);
                camera.setCameraState({ task: 'normal' });
                return false;
            }
        } catch (error) {
            console.error(`[CAM:${camera.getName()}] Error refreshing camera state before patrol:`, error);
            // Continue anyway
        }
        
        const result = await safeMoveCameraToPreset(camera, presetNames[0]);
        if (!result) {
            console.error(`[CAM:${camera.getName()}] Failed to start patrol`);
            camera.setCameraState({ task: 'normal' });
            return false;
        }
        
        // Wait at first position
        await new Promise(resolve => setTimeout(resolve, dwellTime));
    }
    
    // Remaining presets
    for (let i = 1; i < presetNames.length; i++) {
        // Before moving to the next position, check explicitly for objects
        let retryCount = 0;
        let shouldWait = true;
        
        while (shouldWait && retryCount < maxRetries) {
            // Get latest state before deciding to move
            try {
                await refreshCameraState(camera);
                
                if (!camera.sees_objects) {
                    // No objects detected, ok to move
                    shouldWait = false;
                } else {
                    console.log(`[CAM:${camera.getName()}] Objects detected at position ${i}. Waiting...`);
                    
                    // Wait another dwell time and check again
                    await new Promise(resolve => setTimeout(resolve, dwellTime));
                    retryCount++;
                }
            } catch (error) {
                console.error(`[CAM:${camera.getName()}] Error refreshing camera state during patrol:`, error);
                // If we can't get the state, we'll assume it's safe to continue
                shouldWait = false;
            }
        }
        
        if (shouldWait) {
            console.log(`[CAM:${camera.getName()}] Still detecting objects after ${maxRetries} retries, continuing patrol anyway`);
        }
        
        const result = await safeMoveCameraToPreset(camera, presetNames[i]);
        if (!result) {
            console.error(`[CAM:${camera.getName()}] Failed to continue patrol at position ${i+1}`);
            // Try to restore detection
            const originalDetectState = camera.detect_enabled;
            const originalMotionState = camera.motion_enabled;
            if (originalMotionState) {
                await setCameraMotion(camera, true);
            }
            if (originalDetectState) {
                await setCameraDetect(camera, true);
            }
            camera.setCameraState({ task: 'normal' });
            return false;
        }
        
        // Only wait at intermediate positions
        if (i < presetNames.length - 1) {
            await new Promise(resolve => setTimeout(resolve, dwellTime));
        }
    }
    
    camera.setCameraState({ task: 'normal' });
    console.log(`[CAM:${camera.getName()}] Completed patrol`);
    return true;
}

/**
 * Set up rehoming and patrol schedules for all cameras based on their configuration
 */
function setupCameraSchedules(): void {
    console.log("[MAIN] Setting up camera schedules...");
    
    // Set up schedules for each camera
    cameras.forEach((camera) => {
        const cameraConfig = config.cameras.find(c => c.name === camera.getName());
        if (!cameraConfig) {
            console.error(`[MAIN] Could not find configuration for camera ${camera.getName()}`);
            return;
        }
        
        // Set up rehoming schedule if enabled
        if (cameraConfig.rehome && cameraConfig.rehome_after > 0) {
            console.log(`[MAIN] Setting up rehoming schedule for ${camera.getName()} every ${cameraConfig.rehome_after} seconds`);
            setInterval(async () => {
                // Only rehome if the camera is idle
                if (camera.task === 'normal') {
                    try {
                        // Get the latest camera state before deciding to rehome
                        await refreshCameraState(camera);
                        
                        // Check if there are objects detected
                        if (!camera.sees_objects) {
                            console.log(`[CAM:${camera.getName()}] Rehoming to preset ${cameraConfig.rehome_preset}...`);
                            await safeMoveCameraToPreset(camera, cameraConfig.rehome_preset).catch(err => {
                                console.error(`[CAM:${camera.getName()}] Error rehoming:`, err);
                            });
                        } else {
                            console.log(`[CAM:${camera.getName()}] Skipping rehome because objects are detected`);
                        }
                    } catch (err) {
                        console.error(`[CAM:${camera.getName()}] Error checking state before rehoming:`, err);
                    }
                } else {
                    console.log(`[CAM:${camera.getName()}] Skipping rehome because task is currently: ${camera.task}`);
                }
            }, cameraConfig.rehome_after * 1000);
        }
        
        // Set up patrol schedule if enabled
        if (cameraConfig.patrols && cameraConfig.patrol_every > 0 && cameraConfig.patrol_route.length > 0) {
            console.log(`[CAM:${camera.getName()}] Setting up patrol schedule: every ${cameraConfig.patrol_every} seconds with ${cameraConfig.patrol_dwell}s dwell time`);
            setInterval(async () => {
                try {
                    // Get the latest camera state before deciding to patrol
                    await refreshCameraState(camera);
                    
                    // Check if there are objects detected
                    if (camera.sees_objects) {
                        console.log(`[CAM:${camera.getName()}] Skipping patrol because objects are detected`);
                        return;
                    }
                    // Only patrol if the camera is idle
                    if (camera.task === 'normal') {
                        console.log(`[CAM:${camera.getName()}] Starting patrol...`);
                        await patrolCameraPresets(
                            camera, 
                            cameraConfig.patrol_route,
                            cameraConfig.patrol_dwell * 1000 // Convert seconds to milliseconds
                        ).catch(err => {
                            console.error(`[CAM:${camera.getName()}] Error patrolling:`, err);
                        });
                    } else {
                        console.log(`[CAM:${camera.getName()}] Won't start patrol because task is currently: ${camera.task}`);
                    }
                } catch (err) {
                    console.error(`[CAM:${camera.getName()}] Error checking state before patrolling:`, err);
                }
            }, cameraConfig.patrol_every * 1000);
        }
    });
}


/**
 * Initialize camera states based on configuration
 */
async function initializeCameraStates(): Promise<void> {
    console.log("[MAIN] Initializing camera states based on configuration...");
    
    // Get the latest camera states from Frigate
    await pokeFrigate().catch(err => {
        console.error("[MAIN] Error getting initial camera states:", err);
    });
    
    // Set up each camera's state based on configuration
    for (const camera of cameras) {
        const cameraConfig = config.cameras.find(c => c.name === camera.getName());
        if (!cameraConfig) {
            console.error(`[MAIN] Could not find configuration for camera ${camera.getName()}`);
            continue;
        }
        
        console.log(`[CAM:${camera.getName()}] Initializing state based on configuration...`);
        
        // Set motion detection state if it doesn't match the desired state
        if (cameraConfig.want_motion !== camera.motion_enabled) {
            console.log(`[CAM:${camera.getName()}] Setting initial motion detection to: ${cameraConfig.want_motion ? 'ON' : 'OFF'}`);
            await setCameraMotion(camera, cameraConfig.want_motion).catch(err => {
                console.error(`[CAM:${camera.getName()}] Error setting initial motion state:`, err);
            });
        }
        
        // Set object detection state if it doesn't match the desired state
        // Note: Motion detection must be enabled for object detection to be enabled
        if (cameraConfig.want_detect !== camera.detect_enabled) {
            // Only enable object detection if motion detection is also enabled
            if (!cameraConfig.want_detect || (cameraConfig.want_detect && camera.motion_enabled)) {
                console.log(`[CAM:${camera.getName()}] Setting initial object detection to: ${cameraConfig.want_detect ? 'ON' : 'OFF'}`);
                await setCameraDetect(camera, cameraConfig.want_detect).catch(err => {
                    console.error(`[CAM:${camera.getName()}] Error setting initial detect state:`, err);
                });
            } else {
                console.log(`[CAM:${camera.getName()}] Cannot enable object detection because motion detection is disabled`);
            }
        }
    }
    
    console.log("[MAIN] Camera state initialization complete");
}

// Initialize camera schedules and health check after connection is established
(async function initialize() {
    // Wait for connection to be established
    while(!connected_to_broker) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Initialize camera states based on configuration
    await initializeCameraStates();
    
    // Set up camera schedules
    setupCameraSchedules();
    
    // Set up health check
    setupHealthCheck();
})();
