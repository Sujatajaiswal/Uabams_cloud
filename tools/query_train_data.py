import os
import argparse
from pymongo import MongoClient
import dotenv

def main():
    dotenv.load_dotenv()
    url = os.getenv("MONGODB_URL")
    db_name = os.getenv("DATABASE_NAME", "uabams")

    if not url:
        print("Error: MONGODB_URL is not set in your environment or .env file.")
        return

    parser = argparse.ArgumentParser(description="Query UABAMS MongoDB data.")
    parser.add_argument("--train", help="Train ID to show detailed stats for (e.g., TR_001)", default=None)
    args = parser.parse_args()

    print(f"Connecting to MongoDB database '{db_name}'...")
    client = MongoClient(url)
    db = client[db_name]

    # 1. Show overall database collection counts
    print("\n=============================================================")
    print("MONGODB COLLECTIONS OVERALL STATUS")
    print("=============================================================")
    collections = ["trains", "archives", "rms_records", "peak_records", "alert_events", "fault_records"]
    for col in collections:
        count = db[col].count_documents({})
        print(f"Collection '{col:<13}': {count:,} documents")
    print("=============================================================")

    # 2. Query specific train data if requested
    if args.train:
        train_id = args.train
        print(f"\nDetailed stats for Train: {train_id}")
        
        # Check trains collection
        train_doc = db.trains.find_one({"trainNo": train_id}, {"_id": 0})
        if not train_doc:
            print(f"No train record found in 'trains' collection for '{train_id}'")
            return
            
        print("-------------------------------------------------------------")
        print("Trains collection metadata:")
        print(train_doc)
        print("-------------------------------------------------------------")
        
        # Count other collections
        archives_count = db.archives.count_documents({"trainId": train_id})
        rms_count = db.rms_records.count_documents({"trainId": train_id})
        peak_count = db.peak_records.count_documents({"trainId": train_id})
        alerts_count = db.alert_events.count_documents({"trainNo": train_id})
        faults_count = db.fault_records.count_documents({"trainId": train_id})
        
        print(f"Uploaded Archives:   {archives_count}")
        print(f"RMS Data Points:     {rms_count}")
        print(f"Peak Data Points:    {peak_count}")
        print(f"Generated Alerts:    {alerts_count}")
        print(f"Fault Records:       {faults_count}")
        print("-------------------------------------------------------------")
        
        # Print a sample RMS record
        sample_rms = db.rms_records.find_one({"trainId": train_id}, {"_id": 0})
        if sample_rms:
            print("Sample RMS record in database:")
            print(sample_rms)
            print("-------------------------------------------------------------")
    else:
        print("\nTip: Run with --train <train_id> to inspect details. Example:")
        print("   python tools/query_train_data.py --train TR_001")

if __name__ == "__main__":
    main()
