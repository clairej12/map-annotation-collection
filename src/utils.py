import json
import os
import pdb

MAPS_DIR = "data/easy_processed_maps_v2/"
OBSERVATIONS_DIR = "data/thumbnails_sharpened/"
ROUTES_FILE = "data/test_positions_easy_processed_mapped_answered_redistanced_v2.json"
LANDMARKS_FILE = "data/landmarks.json"
route_ids = [10983,4085,2394,11661,9944,4881,5837,5163,3017,2804,9758,4546,7950,2648,5487,1086,2183,8624,8592,8505,5105,11455,7035,6316,9675,8473,8153,9089,9146,4159,8987,4765,9648,5501,1400,299,8262,10232,385,11502,3209,9968,7139,9733,9434,713,3304,8379,6895,2289,9159,31,3536,6485,2342,1835,9091,2468,3846,6094,5428,2167]

def parse_routes():
    data_list = {}
    data = {
        "route_id": None,
        "observations": [],
        "landmarks": [],
    }

    with open(ROUTES_FILE, "r") as f:
        routes_data = json.load(f)
    
    with open(LANDMARKS_FILE, "r") as f:
        landmarks_data = json.load(f)
        landmarks_dict = {route["route_id"]: route["landmarks"] for route in landmarks_data}
    
    for route in routes_data:
        route_id = route["route_id"]
        if route_id not in route_ids:
            continue
        data["route_id"] = route_id
        data["map"] = os.path.join(MAPS_DIR, f"test_easy_processed_maps_{route_id}.png")
        data["observations"] = [os.path.join(
                                    OBSERVATIONS_DIR,
                                    f'{r["pano_id"]}_{r["pano_heading"]}_sharpened.jpg')
                                for r in route["path"]]
        data["landmarks"] = landmarks_dict[route_id] + ["Start (S)", "End (G)", "Endpoint 1", "Endpoint 2", "Endpoint 3"]

        data_list[route_id]=data

        data = {
            "route_id": None,
            "observations": [],
            "landmarks": [],
        }

    return data_list

