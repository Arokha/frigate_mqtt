# Frigate MQTT Rehome/Patrol

This is a simple Node application written in TypeScript that is intended to interface with the [Frigate NVR](https://github.com/blakeblackshear/frigate).

The application does two things for PTZ cameras:
1. Allows cameras to 're-home' to a specific ONVIF preset position after a certain number of seconds with no objects detected by Frigate
2. Allows cameras to 'patrol', proceeding through a set series of ONVIF presets and dwelling at each for a configurable time before moving on

## Running

Copy the config_example.yml file to config.yml and make changes to fit your environment.

An example docker-compose.yml file has been provided for running via docker-compose.

```
docker-compose build
docker-compose up
```

Alternatively you can build and run the application directly with Node:

```
npm run build
npm run start
```

## MQTT Broker

Frigate, nor this application, is an MQTT broker. You will need an MQTT broker to act as an intermediary between Frigate and this application. At the time of this writing, [Mosquitto](https://mosquitto.org/) is a reasonable choice, and has official docker images you can plug-n-play into a docker-compose file with this application.

## Configuration

See `config/config_example.yml`. A config file should be present in `config/config.yml` or the Docker entrypoint script will copy `config_example.yml` there for you to edit if you are using Docker.

## Configuration (Frigate)

MQTT must be enabled in Frigate. It is disabled by default. Refer to the MQTT section in Frigate's docs [here](https://docs.frigate.video/configuration/reference). You should ensure everything is working by using an MQTT client to subscribe to a Frigate MQTT topic on the broker and ensuring you do receive messages.

## Motion/Object Detection

During camera slews, Frigate will sense *a lot* of motion, so this application can temporarily disables both object and motion detection during movements. How long your camera takes to slew is not something we can know, so the config file has a field to input the expected time in seconds it will take, and object/motion detection will be disabled for this amount of time.