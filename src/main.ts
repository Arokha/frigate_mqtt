import { connect } from "mqtt";
import { FrigateCamera, CameraState } from "./camera";
import { readFileSync } from "fs";
import { parse as yamlParse } from "yaml";
import { configSchema } from "./config";
import { frigateStateSchema, FrigateState } from "./frigate";

// Read config from config.yaml file
const configFile = readFileSync("config.yaml", "utf8");
const config = configSchema.parse(yamlParse(configFile));

// Create an array of FrigateCamera instances based on the config
const cameras = config.cameras.map((cameraConfig) => {
    const camera = new FrigateCamera(cameraConfig.name);
    return camera;
});

// Connect to the MQTT broker
let connected_to_broker = false;
const broker = connect(config.mqtt_url, {port: config.mqtt_port});
broker.on("connect", () => {
    console.log("Connected to MQTT broker");
    connected_to_broker = true;
});
broker.on("error", (err) => {
    console.error("Error connecting to MQTT broker:", err);
    connected_to_broker = false;
});
broker.on("close", () => {
    console.log("Connection to MQTT broker closed");
    connected_to_broker = false;
});

// Wait for connection to be established
while(!connected_to_broker) {
    // Wait for the connection to be established
    console.log("Waiting for connection to MQTT broker...");
    setTimeout(() => {}, 1000);
}

// We'll set up listeners for the big 'camera_activity' topic as well as each individual camera's topics
// The 'camera_activity' topic will be used to get the state of each camera
// The individual camera topics will be used to monitor the state of each camera
broker.subscribe(`${config.mqtt_root}/camera_activity`, { qos: 1 }, (err) => {
    if (err) {
        console.error(`Error subscribing to ${config.mqtt_root}/camera_activity:`, err);
    } else {
        console.log(`Subscribed to ${config.mqtt_root}/camera_activity`);
    }
});

// Now the individual camera topics. subscribe() takes an array so we'll just listen to them all at once
const cameraTopics = cameras.map((camera) => {
    return [
        camera.getDetectUpdateTopic(config.mqtt_root),
        camera.getMotionUpdateTopic(config.mqtt_root),
    ];
}).flat();
broker.subscribe(cameraTopics, { qos: 1 }, (err) => {
    if (err) {
        console.error(`Error subscribing to camera topics:`, err);
    } else {
        console.log(`Subscribed to camera topics`);
    }
});

// We'll handle the published messages from the broker here
broker.on("message", (topic, message) => {
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
        const parsedStates = frigateStateSchema.parse(JSON.parse(message.toString()));
        for (const cameraName in parsedStates) {
            const cameraState = parsedStates[cameraName];
            const camera = cameras.find((cam) => cam.getName() === cameraName);
            if (camera) {
                // Update the camera state
                camera.setCameraState({detect_enabled: cameraState.config.detect}); // Unfortunately motion-detection being enabled isn't part of this config blob, only whether there's currently motion
                console.log(`Updated state for ${cameraName}`);
            }
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
                console.log(`Updated motion state for ${cameraName}: ${state}`);
                break;
            case "detect":
                // Update the camera state
                camera.setCameraState({detect_enabled: state === "ON"});
                console.log(`Updated detect state for ${cameraName}: ${state}`);
                break;
        }
    }
});

// If Frigate is running, it will publish to the frigate/camera_activity topic on receiving a message on frigate/onConnect
function pokeBroker() {
    // Frigate publishes a JSON object containing the state of every camera to the topic 'frigate/camera_activity'
    // We can trigger one of these publish events by sending any message to the topic 'frigate/onConnect'
    broker.publish(`${config.mqtt_root}/onConnect`, "poke", { qos: 1, retain: true }, (err) => {
        if (err) {
            console.error("Error publishing to frigate/onConnect:", err);
        } else {
            console.log("Published to frigate/onConnect");
        }
    });
}

function setCameraDetect(camera: FrigateCamera, state: boolean) {
    // Set the camera's detect state
    const topic = camera.getDetectSetTopic(config.mqtt_root);
    const message = state ? "ON" : "OFF";
    broker.publish(topic, message, { qos: 1 }, (err) => {
        if (err) {
            console.error(`Error publishing to ${topic}:`, err);
        } else {
            console.log(`Published to ${topic}: ${message}`);
        }
    });
}

function setCameraMotion(camera: FrigateCamera, state: boolean) {
    // Set the camera's motion state
    const topic = camera.getMotionSetTopic(config.mqtt_root);
    const message = state ? "ON" : "OFF";
    broker.publish(topic, message, { qos: 1 }, (err) => {
        if (err) {
            console.error(`Error publishing to ${topic}:`, err);
        } else {
            console.log(`Published to ${topic}: ${message}`);
        }
    });
}

// At this point all the listeners should be configured and we should be able to push a message to invoke output to frigate/camera_activity topic
// We'll set up a loop to do this every 60 seconds
setInterval(() => {
    pokeBroker();
}, 60000);
