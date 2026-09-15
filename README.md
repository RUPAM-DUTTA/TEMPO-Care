# Human Micro Activity Identification Using mmWave Sensors
<img width="693" height="333" alt="fig_prototype_photos" src="https://github.com/user-attachments/assets/fcb05b5b-559a-4cd4-a8b8-2372ab6f796d" />

## Overview

This project implements a highly stable, real-time Human Activity Recognition (HAR) system using an ESP32 and millimeter-wave radar. By processing spatial and kinematic data, the system detects and classifies human states—such as Walking, Standing, Sitting, and transitional movements—using an on-device machine learning pipeline. The system includes an integrated OLED display for real-time status, SD card data logging, and Bluetooth Low Energy (BLE) broadcasting.
The intelligence of the system relies on a Random Forest classifier, fully contained within the rd03d_model.h file.

## Radar Parameters

The predictive model continuously monitors sliding windows of data. It calculates statistical features (mean, variance, RMS, min, max, etc.) based on the following target parameters:

| Parameter | Description | Unit |
| :--- | :--- | :--- |
| **Distance** | Direct radial distance from the sensor to the tracked target. | mm |
| **Velocity** | Speed of the target moving towards or away from the sensor. | cm/s |
| **AoA** | Angle of Arrival / Azimuth angle of the tracked target. | Degrees (°) |
| **X Coordinate** | Horizontal spatial position relative to the sensor's center. | mm |
| **Y Coordinate** | Depth/forward spatial position relative to the sensor. | mm |

## System Architecture & Pipeline

### Phase 1: Data Collection Setup
Data was collected using a custom ESP32 recording firmware. The setup was designed to capture real-world human movements accurately and consistently.
*   **Protocol:** Data was recorded in structured 10-minute sessions per activity. To avoid fatigue and ensure natural movement, the system utilized automated timing (5-second preparation pauses followed by 5-second active recording windows).
*   **Storage:** Raw telemetry from the radar was logged directly to an onboard SD card in CSV format at a strict 10Hz sampling rate.
*   **Labeling:** Participants explicitly selected their intended activity (1 through 8) via serial command before each session, ensuring perfectly labeled ground-truth datasets.

### Phase 2: Data Preprocessing & Noise Clearing
Raw mmWave radar data is inherently noisy and prone to hardware jitter. A rigorous noise-clearing and feature-extraction pipeline was implemented:
*   **Ghost Rejection:** The system actively filters out "ghost" targets (anomalous radar reflections) by restricting valid data points to realistic physical boundaries (e.g., ignoring data where distance is `< 100mm` or `> 5000mm`).
*   **Signal Smoothing (EMA):** An Exponential Moving Average (EMA) filter is applied to the raw distance and velocity streams to eliminate micro-jitter and hardware anomalies.
*   **Windowing & Feature Extraction:** The smoothed data is buffered into a sliding 50-frame window (representing 5 seconds of historical data). From this buffer, the system calculates 8 statistical metrics per radar parameter (Mean, Median, Standard Deviation, Variance, RMS, Min, Max, Range).
*   **Standardization:** The resulting feature array is normalized using a Standard Scaler (subtracting the mean and dividing by the scale) to ensure the machine learning model interprets all variables equally.

### Phase 3: Model Training
The preprocessed dataset was used to train a **Random Forest Classifier**. 
*   The model evaluates a 41-feature array (40 spatial/kinematic statistics + 1 integer representing the previously predicted state for temporal context).
*   Once trained and validated, the model was converted into a lightweight, edge-compatible C++ header file, represented verbatim in this repository as `rd03d_model.h`.

### Phase 4: Edge Deployment & Inference
The final deployment firmware runs completely standalone on the ESP32.
*   **Multi-Core Processing:** FreeRTOS is utilized to pin the heavy ML inference task to Core 0, while the data collection, OLED rendering, and BLE broadcasting run smoothly on Core 1.
*   **State Machine Backtracking:** To prevent the model from flickering between states, a strict kinematic state machine evaluates predictions. It uses hysteresis gating and backtracking to auto-correct past predictions based on new physical context (e.g., if the user is verified to be sitting, a recent anomalous "walking" prediction is retroactively corrected in the logs).

## Hardware Notice: Discontinuation of C4001

Initial data collection and system architectures were designed for sensor fusion using both the RD-03D and the DFRobot C4001 radar modules.

However, the C4001 has been discontinued from the final inference pipeline due to severe channel interference when operating concurrently with the RD-03D. The system has been refactored, and the trained machine learning model (rd03d_model.h) is now successfully optimized to achieve high-accuracy predictions utilizing exclusively the 41 features extracted from the RD-03D.
c4001_energy (C4001)
